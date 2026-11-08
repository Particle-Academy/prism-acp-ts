// Owned protocol stand-in. Node descendants represent shell -> long-running tool;
// no provider, login, user configuration or external network is accessed.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [family, mode, directory, requestedRole] = process.argv.slice(2);
// Drivers append their own CLI flags after binaryArgs.
const role = ['intermediate', 'grandchild'].includes(requestedRole) ? requestedRole : 'provider';
const self = fileURLToPath(import.meta.url);
setTimeout(() => process.exit(0), 120_000);
if (role !== 'provider') {
  appendFileSync(join(directory, 'descendants.jsonl'), JSON.stringify({ pid: process.pid, ppid: process.ppid, role }) + '\n');
  if (role === 'intermediate') {
    const child = spawn(process.execPath, [self, family, mode, directory, 'grandchild'], { stdio: 'ignore', detached: true });
    child.unref();
  }
} else {
  const child = spawn(process.execPath, [self, family, mode, directory, 'intermediate'], { stdio: 'ignore' });
  child.unref();
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  createInterface({ input: process.stdin }).on('line', raw => {
    const frame = JSON.parse(raw);
    if (family === 'claude') {
      if (frame.type === 'user') writeFileSync(join(directory, 'prompted'), 'ready');
      else if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [], claude_code_version: '2.1.318' } } });
      } else if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
        if (mode === 'timeout') return;
        if (mode === 'rejection') send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Owned interrupt refusal' } });
        else send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { cancelled: ['foreign-fixture-id'], still_queued: [] } } });
        if (mode === 'exited-root') setTimeout(() => process.exit(0), 0);
      }
    } else if (frame.id !== undefined) {
      let result = {};
      if (frame.method === 'initialize') result = { userAgent: 'codex_cli_rs/0.167.0 owned-fixture' };
      else if (frame.method === 'thread/start') result = { thread: { id: 'owned-thread' }, model: 'owned-model' };
      else if (frame.method === 'turn/start') { result = { turn: { id: 'owned-turn' } }; writeFileSync(join(directory, 'prompted'), 'ready'); }
      else if (frame.method === 'turn/interrupt') {
        if (mode === 'no-reply') return;
        if (mode === 'refusal') { send({ jsonrpc: '2.0', id: frame.id, error: { code: -32600, message: 'no active turn' } }); return; }
        if (mode === 'exited-root') { send({ jsonrpc: '2.0', id: frame.id, result }); setTimeout(() => process.exit(0), 0); return; }
      }
      send({ jsonrpc: '2.0', id: frame.id, result });
    }
  });
}
