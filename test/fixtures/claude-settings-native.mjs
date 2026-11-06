import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('./claude-restricted-loopback.mjs', import.meta.url));
const key = 'owned-restricted-synthetic-key';
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function bodyOf(request) {
  let raw = '';
  for await (const chunk of request) { raw += chunk; assert(Buffer.byteLength(raw) < 2_000_000); }
  return raw === '' ? {} : JSON.parse(raw);
}
function json(response, body) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

/** Real executable, finite loopback model/MCP, synthetic key and fresh owned configuration only. */
export async function probeClaudeSettings(binary, { ClaudeDriver, prepareProcessTree }) {
  const root = mkdtempSync(join(tmpdir(), 'prism-settings-native-'));
  const servers = [], scenarios = [], failures = [], blocked = [], requests = [], mcpRequests = [];
  let driver, current;
  const digest = () => createHash('sha256').update(readFileSync(binary)).digest('hex');
  let binarySha256, cliVersion;
  const listen = async handler => {
    const server = createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch(() => { failures.push('owned fixture handler failed'); response.writeHead(500); response.end('{}'); });
    });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };
  try {
    binarySha256 = digest();
    const version = spawnSync(binary, ['--version'], { cwd: root, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
      PATH: dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CLAUDE_CONFIG_DIR: root, TEMP: root, TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(version.status, 0, 'native CLI version must be observable'); cliVersion = version.stdout.trim();
    await prepareProcessTree({ directory: join(root, 'supervisor') });
    const proxy = await listen((request, response) => { blocked.push(request.method); request.resume(); response.writeHead(502); response.end(); });
    proxy.server.on('connect', (_request, socket) => { blocked.push('CONNECT'); socket.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
    const mcp = await listen(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const frame = await bodyOf(request); mcpRequests.push({ scenario: current.name, path: request.url, method: frame.method });
      if (frame.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      if (frame.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Owned settings MCP', version: '1' } };
      else if (frame.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Return an owned marker', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
      else if (frame.method === 'tools/call') result = { content: [{ type: 'text', text: 'OWNED_SUPPLIED_MCP_SUCCESS' }] };
      json(response, result === undefined ? { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Owned fixture method not found' } } : { jsonrpc: '2.0', id: frame.id, result });
    });
    const model = await listen(async (request, response) => {
      const body = await bodyOf(request);
      if (!request.url?.includes('/messages')) { response.writeHead(404); response.end('{}'); return; }
      const toolId = 'toolu_settings_' + current.name;
      const resultSeen = body.messages.some(message => Array.isArray(message.content) && message.content.some(content => content.type === 'tool_result' && content.tool_use_id === toolId));
      requests.push({ scenario: current.name, catalog: (body.tools ?? []).map(tool => tool.name), resultSeen,
        suppliedResult: body.messages.some(message => Array.isArray(message.content) && message.content.some(content => content.type === 'tool_result' && content.tool_use_id === toolId && JSON.stringify(content).includes('OWNED_SUPPLIED_MCP_SUCCESS'))) });
      assert(requests.filter(row => row.scenario === current.name).length <= 3, 'finite owned request budget');
      const content = resultSeen ? [{ type: 'text', text: 'Owned settings probe complete.' }] : [{ type: 'tool_use', id: toolId, name: 'mcp__supplied__echo', input: {} }];
      const message = { id: 'msg_settings', type: 'message', role: 'assistant', model: body.model, content, stop_reason: resultSeen ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
      if (!body.stream) { json(response, message); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { ...message, content: [], stop_reason: null } });
      for (const [index, block] of content.entries()) {
        event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
        event('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
        event('content_block_stop', { index });
      }
      event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } }); event('message_stop', {}); response.end();
    });
    const hookCount = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
    function workspace(name) {
      const ownRoot = join(root, name), home = join(ownRoot, 'home'), cwd = join(ownRoot, 'workspace'), configHome = join(ownRoot, 'config'), temp = join(ownRoot, 'temp');
      for (const directory of [home, cwd, configHome, temp, join(cwd, '.claude')]) mkdirSync(directory, { recursive: true });
      const markers = {};
      const settings = source => {
        const marker = join(ownRoot, source + '-hook.log'), hook = join(ownRoot, source + '-hook.mjs'); markers[source] = marker;
        writeFileSync(hook, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'owned\\n');`);
        return { enableAllProjectMcpServers: true, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: [hook], onFailure: 'block' }] }] } };
      };
      writeFileSync(join(configHome, 'settings.json'), JSON.stringify(settings('user')));
      writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(settings('project')));
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify(settings('local')));
      const explicit = join(ownRoot, 'explicit-settings.json'); writeFileSync(explicit, JSON.stringify(settings('explicit')));
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { folder: { type: 'http', url: `${mcp.url}/folder` } } }));
      return { ownRoot, home, cwd, configHome, temp, markers, explicit };
    }
    async function turn(name, world, policy, { explicit = false, resumeSessionId, expectedHook, folder } = {}) {
      current = { name }; const requestAt = requests.length, mcpAt = mcpRequests.length;
      const before = Object.fromEntries(Object.entries(world.markers).map(([source, file]) => [source, hookCount(file)]));
      const parentEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: dirname(process.execPath), HOME: world.home, USERPROFILE: world.home, APPDATA: world.home, LOCALAPPDATA: world.home, TEMP: world.temp, TMP: world.temp, TMPDIR: world.temp, XDG_CONFIG_HOME: world.home,
        HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
      const errors = []; let finish; const completed = new Promise(resolve => { finish = resolve; });
      const receipt = join(world.ownRoot, name + '-launch.json');
      driver = new ClaudeDriver({ cwd: world.cwd, binary: process.execPath, binaryArgs: [bridge, binary, model.url, receipt, ...(explicit ? ['--settings', world.explicit] : [])], parentEnv,
        allowEnv: ['ENABLE_TOOL_SEARCH', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'],
        credentials: { mode: 'apiKey', apiKey: key, home: world.configHome }, model: 'claude-sonnet-4-6', permissionMode: 'dontAsk', allowedTools: ['mcp__supplied__echo'],
        mcpServers: [{ type: 'http', name: 'supplied', url: `${mcp.url}/supplied`, headers: [] }], ...policy, ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      }, { onProtocolError: error => errors.push(error), onTurnEnd: outcome => finish(outcome) });
      let outcome, stop, sessionId, reports;
      try {
        driver.start(); driver.prompt('Run only the owned supplied MCP fixture.'); await bounded(driver.modelState(), 15_000, 'initialize deadline');
        outcome = await bounded(completed, 25_000, 'owned turn deadline'); sessionId = driver.cliSessionId; reports = driver.mcpServers;
      } finally { stop = await driver.stop({ graceMs: 0 }); assert.deepEqual({ verified: stop.verified, empty: stop.empty, survivors: stop.survivors }, { verified: true, empty: true, survivors: 0 }); }
      const ownRequests = requests.slice(requestAt), ownMcp = mcpRequests.slice(mcpAt), catalog = ownRequests[0]?.catalog ?? [];
      const hooks = Object.fromEntries(Object.entries(world.markers).map(([source, file]) => [source, hookCount(file) - before[source]]));
      const config = JSON.parse(readFileSync(receipt, 'utf8')).mcpConfigPath;
      assert(!existsSync(config) && !existsSync(dirname(config)), 'generated MCP config cleaned after stop');
      assert.equal(outcome.isError, false); assert.equal(errors.length, 0); assert.equal(failures.length, 0);
      if (resumeSessionId !== undefined) assert.equal(sessionId, resumeSessionId, 'resume must keep the original native session identity');
      assert(catalog.includes('mcp__supplied__echo')); assert(ownMcp.some(row => row.path === '/supplied' && row.method === 'tools/list'));
      assert(ownMcp.some(row => row.path === '/supplied' && row.method === 'tools/call')); assert(ownRequests.some(row => row.suppliedResult));
      assert.equal(catalog.includes('mcp__folder__echo'), folder);
      if (folder) assert(ownMcp.some(row => row.path === '/folder' && row.method === 'tools/list'));
      else assert(!ownMcp.some(row => row.path === '/folder'));
      if (expectedHook) assert(hooks[expectedHook] > 0, 'source hook positive control ' + expectedHook);
      if (explicit) assert(hooks.explicit > 0, 'explicit --settings hook still executes');
      if (policy.settingSources !== undefined) for (const source of ['user', 'project', 'local']) if (!policy.settingSources.includes(source)) assert.equal(hooks[source], 0, 'excluded source hook ' + source);
      const row = { name, policy, resumed: resumeSessionId !== undefined, resumeSessionPreserved: resumeSessionId === undefined ? null : sessionId === resumeSessionId, hooks, folderMcpLoaded: catalog.includes('mcp__folder__echo'), suppliedMcpCalled: true, requests: ownRequests.length, reports, stop, configRemoved: true };
      scenarios.push(row); driver = undefined; return sessionId;
    }
    const project = workspace('project');
    const sessionId = await turn('project-positive', project, { settingSources: ['project'] }, { expectedHook: 'project', folder: true });
    assert(typeof sessionId === 'string' && sessionId.length > 0, 'native CLI session identity required');
    // The folder MCP is project-scoped, so excluding project sources also excludes it.
    await turn('local-positive', workspace('local'), { settingSources: ['local'] }, { expectedHook: 'local', folder: false });
    await turn('user-positive', workspace('user'), { settingSources: ['user'] }, { expectedHook: 'user', folder: false });
    await turn('strict-project', workspace('strict-project'), { settingSources: ['project'], strictMcpConfig: true }, { expectedHook: 'project', folder: false });
    await turn('empty-explicit', workspace('empty'), { settingSources: [], strictMcpConfig: true }, { explicit: true, folder: false });
    await turn('user-explicit', workspace('user-explicit'), { settingSources: ['user'], strictMcpConfig: true }, { explicit: true, folder: false });
    await turn('resume-filtered', project, { settingSources: [], strictMcpConfig: true }, { explicit: true, folder: false, resumeSessionId: sessionId });
    await turn('relaunch-filtered', project, { settingSources: [], strictMcpConfig: true }, { explicit: true, folder: false, resumeSessionId: sessionId });
    assert.equal(digest(), binarySha256, 'native executable changed during proof');
    return { realCli: true, cliVersion, binarySha256, realAuthenticationOrModelCall: false, scenarios, blockedConnections: blocked.length };
  } catch (error) {
    console.info(JSON.stringify({ nativeSettingsFailure: { current: current?.name, scenarios, requests, mcpRequests } }));
    throw error;
  } finally {
    if (driver) await driver.stop({ graceMs: 0 });
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const owned = realpathSync(root);
    if (dirname(owned) !== realpathSync(tmpdir()) || !basename(owned).startsWith('prism-settings-native-')) throw new Error('owned settings fixture cleanup refused');
    rmSync(owned, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
