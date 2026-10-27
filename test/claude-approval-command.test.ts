import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalHookScript, approvalSettings, ApprovalServer } from '../src/claude/approvals.js';
import { buildFakeElectron } from './fixtures/fake-electron.js';

const root = mkdtempSync(join(tmpdir(), 'prism-hook-command-'));
const paths = join(root, "a space ' & % é $ `");
mkdirSync(paths);
let electron: string;
beforeAll(() => { electron = buildFakeElectron(paths); }, 60000);
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const socket = () => process.platform === 'win32' ? `\\\\.\\pipe\\prism-hook-${Math.random().toString(36).slice(2)}` : join(mkdtempSync(join(root, 'socket-')), 'a.sock');
const input = { tool_name: 'Bash', tool_input: { command: 'echo harmless', exitCode: 42, permissionDecision: 'allow' }, tool_use_id: 'toolu_probe' };
let sequence = 0;

async function command(options: { env?: Record<string, string>; script?: string; node?: string; electron?: boolean; stdin?: string | Buffer } = {}) {
  const path = join(paths, `approve-${++sequence}.cjs`);
  writeFileSync(path, options.script ?? approvalHookScript(1));
  const settings = approvalSettings(options.node ?? electron, path, ['Bash'], { electron: options.electron ?? true, timeoutSeconds: 1 }) as any;
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(hook.command, hook.args, { env: { ...process.env, PRISM_FAKE_ELECTRON_NODE: process.execPath, ...options.env }, stdio: ['pipe','pipe','pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const deadline = setTimeout(() => { child.kill(); reject(new Error('approval command did not finish')); }, 10000);
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.stdin.on('error', () => {}); child.on('error', reject);
    child.once('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
    child.stdin.end(options.stdin ?? JSON.stringify(input));
  });
}

describe('the actual approval command, including a non-Node Electron executable', () => {
  it('uses paths as data, preserves allow bytes exactly, and removes Electron mode before a child spawns', async () => {
    const reason = "Allowed é ' & % $ ` \\ and a newline\nsecond line" + 'long reason '.repeat(7000);
    const server = new ApprovalServer(socket(), async () => ({ outcome: 'selected', optionId: 'allow_once', reason }));
    const channel = server.listen();
    const script = approvalHookScript(5).replace("const http = require('http');", `const check = require('child_process').spawnSync(${JSON.stringify(process.execPath)}, ['-p', 'String(process.env.ELECTRON_RUN_AS_NODE)'], {encoding:'utf8'}); if (check.stdout.trim() !== 'undefined') process.exit(7); const http = require('http');`);
    try {
      const r = await command({ script, env: { PRISM_ACP_APPROVAL_SOCKET: channel.socket, PRISM_ACP_APPROVAL_TOKEN: channel.token } });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } }) + '\n');
      expect(r.stderr).toBe('');
    } finally { server.close(); }
  });

  for (const mode of ['empty', 'crash', 'invalid']) it(`${mode}: the executable never runs JS, yet the shell adapter denies`, async () => {
    const r = await command({ env: { PRISM_FAKE_ELECTRON_MODE: mode } });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('prism-acp: approval hook failed or denied; tool call blocked\n');
  });

  it('CONTROL: omitting Electron Node mode launches the silent app; the adapter still denies', async () => {
    expect((await command({ electron: false })).code).toBe(2);
  });

  it('supports a trusted explicit ordinary Node executable', async () => {
    const server = new ApprovalServer(socket(), async () => ({ outcome: 'selected', optionId: 'allow_once' }));
    const channel = server.listen();
    try { expect((await command({ node: process.execPath, electron: false, env: { PRISM_ACP_APPROVAL_SOCKET: channel.socket, PRISM_ACP_APPROVAL_TOKEN: channel.token } })).code).toBe(0); }
    finally { server.close(); }
  });

  for (const raw of ['', '{invalid-json', '{}', '{"hookSpecificOutput":{"permissionDecision":"allow"}}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"x"}}\nextra', Buffer.concat([Buffer.from('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"'),Buffer.from([255]),Buffer.from('"}}')])]) {
    it(`an invalid channel response denies (${JSON.stringify(raw).slice(0,65)})`, async () => {
      const address = socket();
      const server = createServer((_req, res) => { res.writeHead(200); res.end(raw); });
      await new Promise<void>(r => server.listen(address, r));
      try {
        const r = await command({ env: { PRISM_ACP_APPROVAL_SOCKET: address, PRISM_ACP_APPROVAL_TOKEN: 'fixture' } });
        expect(r.code).toBe(2); expect(r.stdout).not.toContain('"permissionDecision":"allow"');
      } finally { server.closeAllConnections(); server.close(); }
    });
  }

  for (const fault of ['process.exit(0);', 'process.exit(42);', 'throw new Error("crash");', 'process.stdout.write("extra");', 'process.stdout.write("\\0");']) {
    it(`the worker guard denies missing/extra stdout and errors: ${fault}`, async () => {
      const server = new ApprovalServer(socket(), async () => ({ outcome: 'selected', optionId: 'allow_once' }));
      const channel = server.listen();
      try {
        const r = await command({ script: approvalHookScript(1).replace("const http = require('http');", `${fault} const http = require('http');`), env: { PRISM_ACP_APPROVAL_SOCKET: channel.socket, PRISM_ACP_APPROVAL_TOKEN: channel.token } });
        expect(r.code).toBe(2); expect(r.stdout).not.toContain('"permissionDecision":"allow"');
      } finally { server.close(); }
    });
  }

  it('no answer from a live channel expires as deny before the native timeout', async () => {
    const server = new ApprovalServer(socket(), async () => new Promise(() => {}));
    const channel = server.listen();
    try { expect((await command({ env: { PRISM_ACP_APPROVAL_SOCKET: channel.socket, PRISM_ACP_APPROVAL_TOKEN: channel.token } })).code).toBe(2); }
    finally { server.close(); }
  });

  it('malformed input and a malformed callback result deny, regardless of tool-input exitCode', async () => {
    const server = new ApprovalServer(socket(), async () => null as never);
    const channel = server.listen();
    try {
      const env = { PRISM_ACP_APPROVAL_SOCKET: channel.socket, PRISM_ACP_APPROVAL_TOKEN: channel.token };
      expect((await command({ env })).code).toBe(2);
      expect((await command({ env, stdin: '{bad' })).code).toBe(2);
      expect((await command({ env, stdin: Buffer.concat([Buffer.from('{"command":"'),Buffer.from([255]),Buffer.from('"}')]) })).code).toBe(2);
    } finally { server.close(); }
  });

  it('a multibyte tool input split across IPC chunks reaches the approver unchanged',async()=>{
    let seen: unknown;
    const server=new ApprovalServer(socket(),async input=>{seen=input;return {outcome:'selected',optionId:'allow_once'};});
    const channel=server.listen();
    const body={tool_name:'Bash',tool_input:{command:'echo é🙂'},tool_use_id:'probe'};
    const bytes=Buffer.from(JSON.stringify(body));
    const split=bytes.indexOf(Buffer.from('é'))+1;
    try {
      const status=await new Promise<number|undefined>((resolve,reject)=>{
        const req=request({socketPath:channel.socket,path:'/approve',method:'POST',headers:{authorization:'Bearer '+channel.token,'content-length':bytes.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
        req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),20);
      });
      expect(status).toBe(200);expect(seen).toEqual(body);
    } finally {server.close();}
  });
});
