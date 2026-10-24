// VM-only, isolated network. Real CLIs/packed adapter; one loopback fixture turn persists a resumable thread.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.PRISM_MCP_PROBE_ISOLATED, '1', 'run the isolated VM gate');
assert.equal(Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal).length, 0, 'no external network interface');
const { ClaudeDriver, CodexDriver } = await import(pathToFileURL(join(resolve(process.argv[2] ?? '.'), 'dist/index.js')).href);
const part = process.env.PRISM_MCP_PROBE_PART ?? 'all';
assert(['all', 'codex-deny', 'claude-deny'].includes(part));
const codexBinary = process.env.PRISM_CODEX_PROBE_BINARY; const claudeBinary = process.env.PRISM_CLAUDE_PROBE_BINARY;
assert(codexBinary && claudeBinary, 'resolve installed provider binaries before isolating the network');
console.log(execFileSync(codexBinary, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim());
console.log(execFileSync(claudeBinary, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim());
const dir = await mkdtemp(join(tmpdir(), 'prism-native-mcp-auth-'));
const project = join(dir, 'project'); const codexHome = join(dir, 'codex'); const claudeHome = join(dir, 'claude');
await mkdir(join(project, '.git'), { recursive: true }); await mkdir(join(project, '.claude')); await mkdir(codexHome); await mkdir(claudeHome);
const LEGACY = 'legacy-fixture-key'; const OWN = 'session-one-fixture-key'; const NEXT = 'session-two-fixture-key';
let calls = []; const active = new Set();
const http = createServer((request, response) => {
  void (async () => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let body = ''; for await (const chunk of request) { body += chunk; assert(body.length < 1000000); }
    if (request.url === '/model/responses') {
      calls.push({ path: request.url, method: 'fixture-response' });
      // Native Codex test event shapes: https://github.com/openai/codex/blob/main/codex-rs/core/tests/common/responses.rs
      const events = [
        { type: 'response.created', response: { id: 'fixture-response' } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'fixture-message', content: [{ type: 'output_text', text: 'fixture persisted' }] } },
        { type: 'response.completed', response: { id: 'fixture-response', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    const frame = JSON.parse(body);
    calls.push({ path: request.url, method: frame.method, auth: request.headers.authorization });
    if (frame.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = frame.method === 'initialize' ? { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'native-fixture', version: '1' } }
      : frame.method === 'tools/list' ? { tools: [] } : {};
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
  })().catch(() => response.destroy());
});
await new Promise((yes) => http.listen(0, '127.0.0.1', yes));
const origin = `http://127.0.0.1:${http.address().port}`;
const seen = (path) => calls.some((call) => call.path === path && call.method === 'tools/list');
const until = async (test, label) => {
  const deadline = Date.now() + 15000;
  while (!await test()) { if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`); await delay(25); }
};
const bounded = (promise, label) => {
  let timer; return Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`Timeout: ${label}`)), 25000); })]).finally(() => clearTimeout(timer));
};
const remote = (token) => ({ type: 'http', name: 'tynn', url: `${origin}/session`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });
const stop = async (driver) => { const verdict = await driver.stop({ graceMs: 0 }); assert.equal(verdict.empty, true, 'owned provider tree is empty'); active.delete(driver); };
const marker = join(project, 'stdio-started'); const stdio = join(project, 'stdio-fixture.mjs');
await writeFile(stdio, `import {writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';writeFileSync(${JSON.stringify(marker)},'started');createInterface({input:process.stdin}).on('line',l=>{const f=JSON.parse(l);if(f.id===undefined)return;const result=f.method==='initialize'?{protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'stdio-fixture',version:'1'}}:f.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result})+'\\n');});`);
const base = `model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="${origin}/model"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n[mcp_servers.other]\nurl="${origin}/other"\n`;
const legacyHttp = `[mcp_servers.tynn]\nurl="${origin}/legacy"\nbearer_token_env_var="LEGACY_MCP_KEY"\nhttp_headers={"X-Old-Fixture"="${LEGACY}"}\n`;
const legacyStdio = `[mcp_servers.tynn]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(stdio)}]\n`;
async function codex(label, { entry = legacyHttp, token, disabled = false, resume, persist = false, binaryArgs = [] } = {}) {
  calls = []; await writeFile(join(codexHome, 'config.toml'), base + entry, { mode: 0o600 });
  const problems = []; const updates = [];
  let finishTurn; const turn = new Promise((yes) => { finishTurn = yes; });
  const driver = new CodexDriver({ cwd: project, binary: codexBinary, parentEnv: { ...process.env, CODEX_HOME: codexHome, LEGACY_MCP_KEY: LEGACY }, allowEnv: ['LEGACY_MCP_KEY'],
    ...(token ? { mcpServers: [remote(token)] } : {}), ...(disabled ? { disabledMcpServers: ['tynn'] } : {}), ...(resume ? { resumeSessionId: resume } : {}), binaryArgs,
  }, { onProtocolError: (problem) => problems.push(problem), onUpdate: (update) => updates.push(update), onTurnEnd: (outcome) => finishTurn(outcome) }); active.add(driver);
  try {
    driver.start();
    await bounded(driver.ready, `${label} handshake`);
    assert.deepEqual(problems, [], `${label}: no protocol failure`);
    await until(() => seen('/other'), `${label}: unrelated server is ready`);
    if (disabled) await delay(200);
    if (token) {
      await until(() => seen('/session'), 'session endpoint is ready');
      assert(calls.filter((call) => call.path === '/session').every((call) => call.auth === `Bearer ${token}`), 'per-session bearer reaches expected endpoint');
      assert(!calls.some((call) => call.path === '/legacy'), 'legacy endpoint never receives the session');
    } else if (disabled) assert(!calls.some((call) => call.path === '/legacy'), 'disabled legacy endpoint receives no request');
    else if (entry === legacyHttp) {
      await until(() => seen('/legacy'), 'presence control: legacy server is ready');
      assert(calls.some((call) => call.path === '/legacy' && call.auth === `Bearer ${LEGACY}`));
    } else if (entry === legacyStdio) await until(() => stat(marker).then(() => true, () => false), 'presence control: stdio starts');
    if (persist) {
      driver.prompt('Persist this fixture thread for the resume credential check.');
      const outcome = await bounded(turn, 'loopback fixture turn');
      assert.equal(outcome.isError, false); assert.equal(outcome.stopReason, 'end_turn');
      assert(updates.some((update) => update.sessionUpdate === 'agent_message_chunk' && update.content?.text === 'fixture persisted'));
      assert.equal(calls.filter((call) => call.path === '/model/responses').length, 1, 'one loopback fixture turn, no external model');
    } else assert(!calls.some((call) => call.path?.startsWith('/model')), 'no model request outside the fixture persistence control');
    console.log(`PASS ${label}`); return driver.cliSessionId;
  } finally { await stop(driver); if (disabled) assert(!calls.some((call) => call.path === '/legacy'), 'Codex deny prevents legacy requests through shutdown'); }
}
async function claude(label, { deny = false, hooks = false } = {}) {
  calls = []; const problems = [];
  const driver = new ClaudeDriver({ cwd: project, binary: claudeBinary, permissionMode: 'bypassPermissions',
    credentials: { mode: 'apiKey', apiKey: 'fixture-only-unused-api-key', home: claudeHome },
    parentEnv: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, allowEnv: ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'],
    ...(deny ? { disabledMcpServers: ['tynn'] } : {}), ...(hooks ? { permissionPrompts: { tools: ['Bash'] } } : {}),
  }, { onProtocolError: (problem) => problems.push(problem) }); active.add(driver);
  try {
    driver.start();
    await bounded(driver.modelState(), `${label} initialize`);
    await until(() => seen('/other'), `${label}: unrelated MCP connects`);
    if (deny) await delay(200);
    if (deny) assert(!calls.some((call) => call.path === '/legacy'), 'Claude deny prevents legacy requests with hooks preserved');
    else { await until(() => seen('/legacy'), 'Claude legacy presence control'); assert(calls.some((call) => call.auth === `Bearer ${LEGACY}`)); }
    if (deny) {
      const args = (await readFile(`/proc/${driver.processTree.providerPid}/cmdline`, 'utf8')).split('\0');
      const settingsPath = args[args.indexOf('--settings') + 1];
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.deepEqual(settings.deniedMcpServers, [{ serverName: 'tynn' }]);
      if (hooks) assert.equal(settings.hooks.PreToolUse.length, 1);
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    }
    assert.deepEqual(problems, []); console.log(`PASS ${label}`);
  } finally { await stop(driver); if (deny) assert(!calls.some((call) => call.path === '/legacy'), 'Claude deny prevents legacy requests through shutdown'); }
}
async function contains(root, token) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory() ? await contains(path, token) : item.isFile() && (await readFile(path)).includes(Buffer.from(token))) return true;
  }
  return false;
}

try {
  if (part !== 'claude-deny') {
  await codex('Codex legacy credential presence control');
  if (part === 'all') {
  const thread = await codex('Codex explicit bearer on start', { token: OWN, persist: true });
  await codex('Codex explicit bearer on resume', { token: NEXT, resume: thread });
  }
  await codex('Codex existing HTTP disabled, other MCP retained', { disabled: true });
  await codex('Codex enabled stdio presence control', { entry: legacyStdio }); await rm(marker);
  await codex('Codex existing stdio disabled, other MCP retained', { entry: legacyStdio, disabled: true });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  await codex('Codex absent entry disabled with valid transport', { entry: '', disabled: true });
  await codex('Codex CLI-only entry disabled with valid transport', { entry: '', disabled: true, binaryArgs: ['-c', `mcp_servers.tynn={url="${origin}/legacy"}`] });
  await writeFile(join(codexHome, 'presence-control.txt'), LEGACY, { mode: 0o600 });
  assert(await contains(codexHome, LEGACY), 'persistence scanner detects the control');
  assert(!await contains(codexHome, OWN) && !await contains(codexHome, NEXT), 'new MCP keys are absent from the private CLI home regular files');
  }
  if (part !== 'codex-deny') {
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { tynn: { type: 'http', url: `${origin}/legacy`, headers: { Authorization: `Bearer ${LEGACY}` } }, other: { type: 'http', url: `${origin}/other` } } }));
  await writeFile(join(project, '.claude/settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
  await claude('Claude legacy credential presence control');
  await claude('Claude selective deny without hooks', { deny: true });
  await claude('Claude selective deny shares approval-hook settings', { deny: true, hooks: true });
  }
  console.log('PASS packed adapter with real CLIs; isolated network, one local fixture turn, no external model/inference or user login.');
} finally {
  for (const driver of active) await driver.stop({ graceMs: 0 }).catch(() => {});
  http.closeAllConnections(); await new Promise((yes) => http.close(yes)); await rm(dir, { recursive: true, force: true });
}
