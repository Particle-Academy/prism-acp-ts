import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeDriver, prepareProcessTree } from '../../dist/index.js';

const bridge = fileURLToPath(new URL('./claude-restricted-loopback.mjs', import.meta.url));
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function bodyOf(request) {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 2_000_000) throw new Error('owned request exceeds bound'); }
  return raw === '' ? {} : JSON.parse(raw);
}
function json(response, value) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }

/** Actual pinned native CLI, synthetic key/model/MCP, fresh homes outside the repository. No account or login. */
export async function probeRestrictedClaude(binary) {
  const root = mkdtempSync(join(tmpdir(), 'prism-restricted-native-'));
  const servers = [], scenarios = [], blocked = [], requests = [], mcpRequests = [], failures = [];
  let driver, scenario, ownRoot, finishCall;
  const listen = async handler => {
    const server = createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch(() => { failures.push('owned fixture handler failed'); response.writeHead(500); response.end('{}'); });
    });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };
  try {
    await prepareProcessTree({ directory: join(root, 'supervisor') });
    const proxy = await listen((request, response) => { blocked.push(request.method); request.resume(); response.writeHead(502); response.end(); });
    proxy.server.on('connect', (_request, socket) => { blocked.push('CONNECT'); socket.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
    const mcp = await listen(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const frame = await bodyOf(request); mcpRequests.push({ path: request.url, method: frame.method });
      if (frame.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      if (frame.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Owned restricted MCP', version: '1' } };
      else if (frame.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Return an owned fixture marker', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
      else if (frame.method === 'tools/call') {
        if (scenario === 'mcp-cancel') { finishCall(); return; }
        result = { content: [{ type: 'text', text: 'OWNED_MCP_SUCCESS' }] };
      }
      json(response, result === undefined ? { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Owned fixture method not found' } } : { jsonrpc: '2.0', id: frame.id, result });
    });
    const model = await listen(async (request, response) => {
      const body = await bodyOf(request);
      if (!request.url?.includes('/messages')) { response.writeHead(404); response.end('{}'); return; }
      requests.push({ scenario, ...body });
      assert(requests.filter(row => row.scenario === scenario).length <= 4, 'owned finite request budget');
      const resultSeen = body.messages.some(message => Array.isArray(message.content) && message.content.some(content => content.type === 'tool_result'));
      const tool = scenario === 'baseline' ? null : ['mcp', 'mcp-cancel'].includes(scenario) ? 'mcp__owned__echo' : scenario;
      const input = tool === 'Bash' ? { command: 'node -e "require(\'fs\').writeFileSync(\'native-executed\',\'owned\')"' }
        : tool === 'Read' ? { file_path: join(ownRoot, 'owned-secret') }
        : tool === 'Write' ? { file_path: join(ownRoot, 'native-executed'), content: 'owned' }
        : tool === 'WebFetch' ? { url: `${mcp.url}/native-web`, prompt: 'Read this owned fixture' } : {};
      const content = resultSeen || tool === null ? [{ type: 'text', text: 'Owned probe complete.' }] : [{ type: 'tool_use', id: 'toolu_owned', name: tool, input }];
      const message = { id: 'msg_owned', type: 'message', role: 'assistant', model: body.model, content, stop_reason: resultSeen || tool === null ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
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
    for (scenario of ['baseline', 'mcp', 'Bash', 'Read', 'Write', 'WebFetch', 'mcp__inherited__echo', 'mcp-cancel']) {
      ownRoot = join(root, scenario);
      const home = join(ownRoot, 'home'), cwd = join(ownRoot, 'workspace'), configHome = join(ownRoot, 'config'), temp = join(ownRoot, 'temp');
      for (const directory of [home, cwd, configHome, temp, join(cwd, '.claude')]) mkdirSync(directory, { recursive: true });
      writeFileSync(join(ownRoot, 'owned-secret'), 'OWNED_PRIVATE_READ_MUST_NOT_APPEAR');
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { inherited: { type: 'http', url: `${mcp.url}/inherited` } } }));
      const hook = join(ownRoot, 'hook.mjs');
      writeFileSync(hook, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(join(ownRoot, 'inherited-hook-executed'))},'owned');`);
      const settings = { permissions: { allow: ['Bash', 'Read', 'Write', 'WebFetch', 'mcp__inherited__echo'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: process.execPath, args: [hook], onFailure: 'block' }] }] } };
      writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(settings)); writeFileSync(join(configHome, 'settings.json'), JSON.stringify(settings));
      const parentEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp, XDG_CONFIG_HOME: home,
        HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
      const errors = [];
      let finish; const completed = new Promise(resolve => { finish = resolve; });
      const called = new Promise(resolve => { finishCall = resolve; });
      const receipt = join(ownRoot, 'owned-launch.json');
      const requestAt = requests.length, mcpAt = mcpRequests.length;
      driver = new ClaudeDriver({ cwd, binary: process.execPath, binaryArgs: [bridge, binary, model.url, receipt], parentEnv,
        allowEnv: ['ENABLE_TOOL_SEARCH', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'],
        credentials: { mode: 'apiKey', apiKey: 'owned-restricted-synthetic-key', home: configHome }, model: 'claude-sonnet-4-6', permissionMode: 'dontAsk', allowedTools: ['mcp__owned__echo'],
        mcpServers: [{ type: 'http', name: 'owned', url: `${mcp.url}/owned`, headers: [] }],
        ...(scenario === 'baseline' ? {} : { nativeTools: 'none', ...(process.platform === 'win32' ? { processTree: { windowsStdio: 'local-pipes', startupTimeoutMs: 5000 } } : {}) }),
      }, { onProtocolError: error => errors.push(error), onTurnEnd: outcome => finish(outcome) });
      let outcome, stop;
      try {
        driver.start(); driver.prompt('Run only the owned fixture probe.'); await bounded(driver.modelState(), 15000, 'initialize deadline');
        if (scenario === 'mcp-cancel') { await bounded(called, 10000, 'owned tool call deadline'); await driver.cancel(); }
        outcome = await bounded(completed, 20000, 'owned turn deadline');
      }
      finally { stop = await driver.stop({ graceMs: 0 }); assert.deepEqual({ verified: stop.verified, empty: stop.empty, survivors: stop.survivors }, { verified: true, empty: true, survivors: 0 }); }
      const ownRequests = requests.slice(requestAt), ownMcp = mcpRequests.slice(mcpAt);
      const catalog = ownRequests[0]?.tools?.map(tool => tool.name) ?? [];
      const toolResults = ownRequests.flatMap(row => row.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(content => content.type === 'tool_result') : []));
      const hookExecuted = existsSync(join(ownRoot, 'inherited-hook-executed')), nativeExecuted = existsSync(join(ownRoot, 'native-executed')) || existsSync(join(cwd, 'native-executed'));
      const config = JSON.parse(readFileSync(receipt, 'utf8')).mcpConfigPath;
      const configRemoved = !existsSync(config) && !existsSync(dirname(config));
      const row = { scenario, outcome, errors, catalog, requests: ownRequests.length, mcpCalls: ownMcp.filter(request => request.method === 'tools/call').length, hookExecuted, nativeExecuted, configRemoved, reports: driver.mcpServers, stop };
      scenarios.push(row);
      assert.equal(outcome.isError, false, driver.stderr); assert.equal(errors.length, 0); assert.equal(failures.length, 0);
      assert(configRemoved, 'private generated config removed after stop');
      if (scenario === 'baseline') { assert(catalog.includes('Bash') && catalog.includes('Read') && catalog.includes('WebFetch')); assert(catalog.includes('mcp__inherited__echo')); assert(hookExecuted, 'planted hook positive control'); }
      else {
        assert(catalog.every(name => name === 'mcp__owned__echo' || name === 'EndConversation')); assert(!hookExecuted && !nativeExecuted);
        assert(!ownMcp.some(request => request.path === '/inherited' || request.path === '/native-web'));
        assert(!JSON.stringify(toolResults).includes('OWNED_PRIVATE_READ_MUST_NOT_APPEAR'));
        if (scenario === 'mcp-cancel') { assert.equal(row.mcpCalls, 1); assert.equal(outcome.stopReason, 'cancelled'); }
        else if (scenario === 'mcp') { assert.equal(row.mcpCalls, 1); assert(JSON.stringify(toolResults).includes('OWNED_MCP_SUCCESS')); }
        else { assert.equal(row.mcpCalls, 0); assert(toolResults.some(result => result.is_error === true), 'unavailable tool refused'); }
      }
      driver = undefined;
    }
    return { cliVersion: '2.1.311', binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), realAuthenticationOrModelCall: false, scenarios, blockedConnections: blocked.length };
  } finally {
    if (driver) await driver.stop({ graceMs: 0 });
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const owned = realpathSync(root);
    if (dirname(owned) !== realpathSync(tmpdir()) || !basename(owned).startsWith('prism-restricted-native-')) throw new Error('owned fixture cleanup refused');
    rmSync(owned, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
