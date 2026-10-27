// Opt-in native Codex proof. All credentials are dummy; every inference response comes from this loopback fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.PRISM_MCP_PROBE_FIXTURE_ONLY, '1', 'opt in to the local native fixture');
if (process.env.PRISM_MCP_PROBE_ISOLATED === '1') {
  assert.equal(Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal).length, 0, 'network namespace has only loopback');
}
const binary = process.env.PRISM_CODEX_PROBE_BINARY;
assert(binary, 'supply the absolute native Codex binary');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
const { CodexDriver } = await import(pathToFileURL(join(resolve(process.argv[2] ?? '.'), 'dist/index.js')).href);
const part = process.env.PRISM_MCP_ENV_PROBE_PART ?? 'all';
assert(['all', 'legacy', 'filters'].includes(part));
const root = await mkdtemp(join(tmpdir(), 'prism-native-mcp-env-'));
const home = join(root, 'codex'); const project = join(root, 'project');
await mkdir(home, { mode: 0o700 }); await mkdir(join(project, '.git'), { recursive: true, mode: 0o700 });
const LEGACY = 'legacy-native-env-fixture';
const tokens = ['first-native-env-fixture', 'resume-native-env-fixture', 'filters-native-env-fixture'];
const active = new Set(); let current; let caseNumber = 0;
const passed = [];
const bounded = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`Timeout: ${label}`)), 30000); })]); }
  finally { clearTimeout(timer); }
};
const until = async (test, label) => {
  const deadline = Date.now() + 15000;
  while (!test()) { if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`); await delay(25); }
};
const toolsOf = (tools, prefix = '') => tools.flatMap((tool) => Array.isArray(tool.tools)
  ? toolsOf(tool.tools, prefix + (tool.name ? tool.name + '.' : ''))
  : typeof tool.name === 'string' ? [{ name: prefix + tool.name, tool }] : []);
function sse(response, events) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
const server = createServer((request, response) => {
  void (async () => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let text = ''; for await (const bytes of request) { text += bytes; assert(text.length < 5_000_000, 'fixture request bound'); }
    const body = JSON.parse(text); assert(current, 'request belongs to an active case');
    if (request.url === '/model/responses') {
      current.modelCalls++;
      const tools = toolsOf(body.tools ?? []);
      assert.equal(tools.some((entry) => /(^|\.)view_image$/.test(entry.name)), current.viewImage,
        'unrelated view_image feature survives session snapshot override');
      const id = `response-${caseNumber}-${current.modelCalls}`;
      const completed = { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
      if (current.modelCalls === 1) {
        const selected = tools.find((entry) => /(^|\.)(exec_command|shell_command|shell)$/.test(entry.name));
        assert(selected, 'native request offers a shell tool');
        const command = process.platform === 'win32' ? "& 'C:/Program Files/Git/usr/bin/env.exe'" : 'env';
        const args = /exec_command$/.test(selected.name) ? { cmd: command, login: false, yield_time_ms: 1000, max_output_tokens: 8000 }
          : /shell_command$/.test(selected.name) ? { command, login: false, timeout_ms: 10000 } : { command: ['env'], timeout_ms: 10000 };
        current.callId = `env-${caseNumber}`;
        sse(response, [{ type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item: { type: 'function_call', id: `fc-${caseNumber}`, call_id: current.callId,
            name: selected.name, arguments: JSON.stringify(args) } }, completed]);
      } else {
        assert.equal(current.modelCalls, 2, 'exactly one native shell tool call per turn');
        const output = (body.input ?? []).findLast((item) => item.type === 'function_call_output' && item.call_id === current.callId);
        assert(output, 'native shell result reaches the fixture model');
        current.output = typeof output.output === 'string' ? output.output : JSON.stringify(output.output);
        sse(response, [{ type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item: { type: 'message', id: `done-${caseNumber}`, role: 'assistant',
            content: [{ type: 'output_text', text: 'local fixture complete' }] } }, completed]);
      }
      return;
    }
    assert(['/legacy', '/session', '/other'].includes(request.url), 'fixture MCP route');
    current.calls.push({ path: request.url, method: body.method, auth: request.headers.authorization });
    if (body.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : body.method === 'tools/list' ? { tools: [] } : {};
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  })().catch((error) => { if (current) { current.fixtureError = error; current.finish?.({ isError: true }); } response.destroy(); });
});
await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
const origin = `http://127.0.0.1:${server.address().port}`;
const safeNames = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE']);
const baseEnv = {};
for (const name of Object.keys(process.env)) {
  if (!safeNames.has(name.toUpperCase())) continue;
  const value = process.env[name];
  if (value !== undefined) baseEnv[name] = value;
}

async function contains(directory, token) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // The CLI owns its credential store. Never inspect its contents, even in this synthetic probe.
    if (['auth.json', '.credentials.json', 'credentials.json', 'tokens.json', 'token.json'].includes(entry.name.toLowerCase())) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory() ? await contains(path, token) : entry.isFile() && (await readFile(path)).includes(Buffer.from(token))) return true;
  }
  return false;
}

async function runCase(label, { token, resume, filters = false, viewImage = false } = {}) {
  caseNumber++;
  current = { calls: [], modelCalls: 0, output: '', viewImage, fixtureError: null };
  const policy = `[shell_environment_policy]\ninherit="all"\nignore_default_excludes=true\nset={PRISM_FIXTURE_SET="visible"}\n`
    + (filters ? `[shell_environment_policy.filters]\n"PRISM_FIXTURE_HIDDEN"="exclude"\n` : `exclude=["PRISM_FIXTURE_HIDDEN"]\n`);
  await writeFile(join(home, 'config.toml'), `model="fixture"\nmodel_provider="fixture"\n`
    + `[model_providers.fixture]\nname="Fixture"\nbase_url="${origin}/model"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`
    + `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n[features]\nshell_snapshot=true\nview_image=${viewImage}\n`
    + `[mcp_servers.fixture]\nurl="${origin}/legacy"\nbearer_token_env_var="LEGACY_MCP_KEY"\n`
    + `[mcp_servers.other]\nurl="${origin}/other"\n` + policy, { mode: 0o600 });
  const problems = []; let finish;
  const turn = new Promise((yes) => { finish = yes; });
  current.finish = finish;
  const driver = new CodexDriver({ binary, cwd: project, model: 'fixture', approvalPolicy: 'never', sandbox: 'danger-full-access',
    parentEnv: { ...baseEnv, CODEX_HOME: home, CODEX_CONFIG_DIR: home, XDG_CONFIG_HOME: home, HOME: root, USERPROFILE: root,
      APPDATA: root, LOCALAPPDATA: root, LEGACY_MCP_KEY: LEGACY, PRISM_FIXTURE_HIDDEN: 'must-be-excluded', PRISM_FIXTURE_VISIBLE: 'visible' },
    allowEnv: ['LEGACY_MCP_KEY', 'PRISM_FIXTURE_HIDDEN', 'PRISM_FIXTURE_VISIBLE'],
    ...(resume ? { resumeSessionId: resume } : {}),
    ...(token ? { mcpServers: [{ type: 'http', name: 'fixture', url: `${origin}/session`, headers: [{ name: 'Authorization', value: ` \tBearer ${token} \t` }] }] } : {}),
  }, { onProtocolError: (problem) => problems.push(problem), onTurnEnd: (outcome) => finish(outcome) });
  active.add(driver);
  try {
    driver.start(); await bounded(driver.ready, `${label} handshake`);
    assert.deepEqual(problems, [], `${label}: protocol remains healthy`);
    await until(() => current.calls.some((call) => call.path === '/other' && call.method === 'tools/list'), 'unrelated MCP remains available');
    driver.prompt('Execute only the local fixture shell command.');
    const outcome = await bounded(turn, `${label} native shell turn`);
    if (current.fixtureError) throw current.fixtureError;
    assert.equal(outcome.isError, false, 'deterministic native shell turn completes');
    assert.equal(current.modelCalls, 2, 'one local tool call and one fixed final response');
    assert(current.output.includes('PRISM_FIXTURE_VISIBLE=visible'), 'native shell env positive presence control');
    assert(current.output.includes('PRISM_FIXTURE_SET=visible'), 'effective set policy survives');
    assert(!current.output.includes('must-be-excluded'), 'user exclusion remains effective');
    if (token) {
      assert(!current.output.includes(token), 'MCP bearer is absent from native model-run env');
      assert(!current.output.includes('PRISM_ACP_MCP_TOKEN_'), 'binding name is absent from native model-run env');
      const sessionCalls = current.calls.filter((call) => call.path === '/session');
      assert(sessionCalls.some((call) => call.method === 'tools/list'), 'session MCP connects');
      assert(sessionCalls.every((call) => call.auth === `Bearer ${token}`), 'per-session bearer reaches expected endpoint');
      assert(!current.calls.some((call) => call.path === '/legacy'), 'old MCP endpoint is not contacted');
    } else {
      assert(current.calls.some((call) => call.path === '/legacy' && call.auth === `Bearer ${LEGACY}`), 'legacy credential presence control');
    }
    passed.push(label); console.log(`PASS ${label}`); return driver.cliSessionId;
  } finally {
    const verdict = await driver.stop({ graceMs: 0 });
    assert.equal(verdict.verified, true, 'provider cleanup is observed');
    assert.equal(verdict.empty, true, 'provider tree is empty'); assert.equal(verdict.survivors, 0);
    active.delete(driver);
  }
}

try {
  if (part !== 'filters') {
    await runCase('native inherited-credential and unrelated-feature presence controls', { viewImage: true });
    const thread = await runCase('native hostile legacy policy excludes bearer on start', { token: tokens[0] });
    await runCase('native hostile legacy policy excludes fresh bearer on resume', { token: tokens[1], resume: thread });
  }
  if (part !== 'legacy') await runCase('native hostile keyed filters exclude bearer', { token: tokens[2], filters: true });
  await writeFile(join(home, 'scanner-presence.txt'), LEGACY, { mode: 0o600 });
  assert(await contains(home, LEGACY), 'persistence scanner positive presence control');
  for (const token of tokens) assert(!await contains(home, token), 'forwarded MCP bearer is absent from scanned non-credential CLI-home files');
  console.log(JSON.stringify({ version, part, passed, fixtureOnly: true, externalInference: false, credentialStoresInspected: false }));
} finally {
  for (const driver of active) await driver.stop({ graceMs: 0 });
  server.closeAllConnections(); await new Promise((yes) => server.close(yes));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
