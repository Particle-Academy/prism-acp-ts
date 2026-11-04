import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Real CLI, owned append files/plugins, finite loopback model and MCP; no real login or model request. */
export async function probeClaudeFileOptions(binary, { ClaudeDriver, prepareProcessTree }) {
    const pre = { binary, binarySha256: hash(binary) };
    const parent = fs.realpathSync(os.tmpdir()), ownRoot = fs.mkdtempSync(path.join(parent, 'prism-file-options-native-')), bridge = fileURLToPath(new URL('./claude-restricted-loopback.mjs', import.meta.url)), markerA = 'OWNED_FILE_APPEND_A_125b574d', markerB = 'OWNED_FILE_APPEND_B_d9f8ea16', key = 'owned-restricted-synthetic-key', scenarios = [], pluginNoneRefusals = [], requests = [], mcpCalls = [], servers = [], blocked = [], errors = [];
    let current, driver, failed = null;
    function writeFixtureZip(output, directory) {
        // Git is already required by the test checkout. Archive only three owned
        // fixture files, with an empty global config, templates and hooks.
        const empty = path.join(ownRoot, 'git-empty');
        const globalConfig = path.join(ownRoot, 'git-global');
        if (!fs.existsSync(empty))
            fs.mkdirSync(empty);
        if (!fs.existsSync(globalConfig))
            fs.writeFileSync(globalConfig, '');
        const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
            PATH: process.env.PATH, HOME: ownRoot, USERPROFILE: ownRoot,
            APPDATA: ownRoot, LOCALAPPDATA: ownRoot, TEMP: ownRoot, TMP: ownRoot,
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig };
        const git = args => {
            const result = spawnSync('git', ['-c', 'core.hooksPath=' + empty,
                '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args], { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
            assert.equal(result.status, 0, 'Owned plugin zip must be generated');
            return result.stdout.trim();
        };
        git(['init', '--quiet', '--initial-branch=fixture', '--template=' + empty]);
        git(['add', '--', '.claude-plugin/plugin.json', 'hooks/hooks.json', 'hook.mjs']);
        const tree = git(['write-tree']);
        assert(/^[0-9a-f]{40}$/.test(tree));
        git(['archive', '--format=zip', '--output=' + output, tree]);
    }
    async function bounded(promise, ms, label) { let timer; try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]);
    }
    finally {
        clearTimeout(timer);
    } }
    async function bodyOf(request) { let raw = ''; for await (const chunk of request) {
        raw += chunk;
        assert(Buffer.byteLength(raw) < 2000000, 'Owned request size');
    } return raw === '' ? {} : JSON.parse(raw); }
    const json = (response, body) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    async function listen(handler) { const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => { errors.push('owned-handler-error'); response.writeHead(500); response.end('{}'); }); }); servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, url: 'http://127.0.0.1:' + server.address().port }; }
    function pluginMatch(name, label) { return name.includes(label) || name.includes(label.replaceAll('-', '_')); }
    try {
        const version = spawnSync(binary, ['--version'], { cwd: ownRoot, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: ownRoot, USERPROFILE: ownRoot, APPDATA: ownRoot, LOCALAPPDATA: ownRoot, CLAUDE_CONFIG_DIR: ownRoot, TEMP: ownRoot, TMP: ownRoot }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.equal(version.status, 0, 'Native version must be observable');
        pre.cliVersion = version.stdout.trim();
        await prepareProcessTree({ directory: path.join(ownRoot, 'supervisor') });
        const proxy = await listen((request, response) => { blocked.push(request.method); request.resume(); response.writeHead(502); response.end(); });
        proxy.server.on('connect', (_request, socket) => { blocked.push('CONNECT'); socket.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
        const mcp = await listen(async (request, response) => { if (request.method !== 'POST') {
            response.writeHead(405);
            response.end();
            return;
        } const frame = await bodyOf(request); mcpCalls.push({ scenario: current.name, path: request.url, method: frame.method }); if (frame.id === undefined) {
            response.writeHead(202);
            response.end();
            return;
        } let result; if (frame.method === 'initialize')
            result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Owned file-option MCP', version: '1' } };
        else if (frame.method === 'tools/list')
            result = { tools: [{ name: 'echo', description: 'Return the owned file-option marker', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
        else if (frame.method === 'tools/call')
            result = { content: [{ type: 'text', text: 'OWNED_FILE_MCP_SUCCESS' }] }; json(response, result === undefined ? { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Owned fixture method not found' } } : { jsonrpc: '2.0', id: frame.id, result }); });
        const model = await listen(async (request, response) => { const body = await bodyOf(request); if (!request.url?.includes('/messages')) {
            response.writeHead(404);
            response.end('{}');
            return;
        } const catalog = (body.tools ?? []).map(t => t.name), selected = ['mcp__supplied__echo', ...current.plugins.map(label => catalog.find(name => pluginMatch(name, label)))]; assert(selected.every(Boolean), 'Every requested owned plugin must expose its MCP tool'); assert.equal(new Set(selected).size, selected.length); const ids = selected.map((_, i) => 'toolu_files_' + current.name + '_' + i), contents = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []), done = ids.every(id => contents.some(c => c.type === 'tool_result' && c.tool_use_id === id)), system = JSON.stringify(body.system ?? ''); requests.push({ scenario: current.name, appendA: system.includes(markerA), appendB: system.includes(markerB), restrictedCatalogSafe: !current.restricted || catalog.every(name => name === 'mcp__supplied__echo' || name === 'EndConversation'), ownedPluginTools: catalog.filter(n => n.includes('owned')), allOwnedToolResults: ids.every(id => contents.some(c => c.type === 'tool_result' && c.tool_use_id === id && JSON.stringify(c).includes('OWNED_FILE_MCP_SUCCESS'))), toolResults: contents.filter(c => c.type === 'tool_result' && ids.includes(c.tool_use_id)).map(c => ({ id: c.tool_use_id, error: c.is_error === true, ownedSuccess: JSON.stringify(c).includes('OWNED_FILE_MCP_SUCCESS'), permissionError: /permission|denied|not allowed|not permitted/i.test(JSON.stringify(c)) })) }); assert(requests.filter(r => r.scenario === current.name).length <= 3, 'Finite owned model budget'); const content = done ? [{ type: 'text', text: 'Owned file-option observation complete.' }] : selected.map((name, i) => ({ type: 'tool_use', id: ids[i], name, input: {} })), message = { id: 'msg_file-options', type: 'message', role: 'assistant', model: body.model, content, stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }; if (!body.stream) {
            json(response, message);
            return;
        } response.writeHead(200, { 'content-type': 'text/event-stream' }); const event = (type, data) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n'); event('message_start', { message: { ...message, content: [], stop_reason: null } }); for (const [index, block] of content.entries()) {
            event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
            event('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: block.text } });
            event('content_block_stop', { index });
        } event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } }); event('message_stop', {}); response.end(); });
        function world(name) { const base = path.join(ownRoot, name), w = { base, home: path.join(base, 'home'), cwd: path.join(base, 'work'), config: path.join(base, 'config'), temp: path.join(base, 'temp') }; for (const f of [w.home, w.cwd, w.config, w.temp])
            fs.mkdirSync(f, { recursive: true }); w.fileA = path.join(base, 'append A $` % &.txt'); w.fileB = path.join(base, 'append B $` % &.txt'); fs.writeFileSync(w.fileA, markerA); fs.writeFileSync(w.fileB, markerB); w.plugins = {}; for (const [label, zip] of [['owned-files-dir', false], ['owned-files-zip', true]]) {
            const p = path.join(base, label + ' % &'), hook = path.join(p, 'hook.mjs'), marker = path.join(base, label + '.hook');
            fs.mkdirSync(path.join(p, '.claude-plugin'), { recursive: true });
            fs.mkdirSync(path.join(p, 'hooks'));
            fs.writeFileSync(hook, "import fs from 'node:fs';fs.appendFileSync(" + JSON.stringify(marker) + ",'owned\\n');\n");
            fs.writeFileSync(path.join(p, '.claude-plugin/plugin.json'), JSON.stringify({ name: label, version: '0.0.0', description: 'Owned finite file-option fixture', author: { name: 'Owned fixture' }, mcpServers: { owned: { type: 'http', url: mcp.url + '/' + label } } }));
            fs.writeFileSync(path.join(p, 'hooks/hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: [hook], onFailure: 'block' }] }] } }));
            let input = p;
            if (zip) {
                input = path.join(base, 'plugin zip % &.zip');
                writeFixtureZip(input, p);
            }
            w.plugins[label] = { input, marker };
        } return w; }
        const count = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
        async function turn(name, w, { append, plugins = [], resume, restricted = false } = {}) {
            current = { name, plugins, restricted };
            const before = Object.fromEntries(Object.entries(w.plugins).map(([k, p]) => [k, count(p.marker)])), requestAt = requests.length, mcpAt = mcpCalls.length, receipt = path.join(w.base, name + '.launch.json'), argv = [bridge, pre.binary, model.url, receipt];
            let finish;
            const completed = new Promise(resolve => { finish = resolve; }), protocolErrors = [];
            let stderrBytes = 0, cliErrorKind = null;
            const parentEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: w.home, USERPROFILE: w.home, APPDATA: w.home, LOCALAPPDATA: w.home, TEMP: w.temp, TMP: w.temp, TMPDIR: w.temp, XDG_CONFIG_HOME: w.home, HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
            driver = new ClaudeDriver({ cwd: w.cwd, binary: process.execPath, binaryArgs: argv, parentEnv, allowEnv: ['ENABLE_TOOL_SEARCH', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'], credentials: { mode: 'apiKey', apiKey: key, home: w.config }, model: 'claude-sonnet-4-6', permissionMode: 'dontAsk', allowedTools: ['mcp__supplied__echo', ...plugins.map(p => 'mcp__plugin_' + p + '_owned__echo')], ...(restricted ? { nativeTools: 'none', ...(process.platform === 'win32' ? { processTree: { windowsStdio: 'local-pipes', startupTimeoutMs: 5000 } } : {}) } : {}), settingSources: [], appendSystemPromptFile: append, pluginDirs: plugins.map(p => w.plugins[p].input), mcpServers: [{ type: 'http', name: 'supplied', url: mcp.url + '/supplied', headers: [] }], ...(resume ? { resumeSessionId: resume } : {}) }, { onTurnEnd: o => finish(o), onProtocolError: e => protocolErrors.push(e), onStderr: s => { stderrBytes += Buffer.byteLength(s); if (/unknown option/i.test(s))
                    cliErrorKind = 'unknown-option'; } });
            let outcome, sessionId, stop, turnError = null;
            try {
                driver.start();
                driver.prompt('Use only the owned MCP fixture tools.');
                await bounded(driver.modelState(), 15000, 'initialize-deadline');
                outcome = await bounded(completed, 25000, 'turn-deadline');
                sessionId = driver.cliSessionId;
            }
            catch (e) {
                turnError = e instanceof Error ? e.name : 'unknown-error';
            }
            finally {
                stop = await driver.stop({ graceMs: 0 });
                driver = null;
            }
            const own = requests.slice(requestAt), calls = mcpCalls.slice(mcpAt), hooks = Object.fromEntries(Object.entries(w.plugins).map(([k, p]) => [k, count(p.marker) - before[k]])), config = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')).mcpConfigPath : null, configRemoved = config !== null && !fs.existsSync(config) && !fs.existsSync(path.dirname(config)), row = { name, appendRequested: append === w.fileA ? 'A' : append === w.fileB ? 'B' : null, plugins, restricted, resumed: Boolean(resume), resumeSessionPreserved: resume ? sessionId === resume : null, requests: own.length, appendA: own[0]?.appendA ?? false, appendB: own[0]?.appendB ?? false, restrictedCatalogSafe: own.every(r => r.restrictedCatalogSafe), systemMarkersStable: own.every(r => r.appendA === own[0].appendA && r.appendB === own[0].appendB), ownedPluginTools: own[0]?.ownedPluginTools ?? [], allOwnedToolResults: own.some(r => r.allOwnedToolResults), hooks, suppliedMcpCalled: calls.some(c => c.path === '/supplied' && c.method === 'tools/call'), mcpMethods: calls.map(c => ({ path: c.path, method: c.method })), toolResults: own.map(r => r.toolResults), pluginMcpCalls: plugins.map(p => ({ plugin: p, called: calls.some(c => c.path === '/' + p && c.method === 'tools/call') })), stop: { verified: stop.verified, empty: stop.empty, survivors: stop.survivors }, configRemoved, turnError, cliErrorKind, stderrBytes, protocolErrors: protocolErrors.length };
            scenarios.push(row);
            assert(stop.verified && stop.empty && stop.survivors === 0, 'Stop0');
            assert.equal(turnError, null, 'Native scenario failed without logging content');
            assert.equal(outcome.isError, false);
            assert.equal(protocolErrors.length, 0);
            assert(configRemoved);
            assert(own.some(r => r.allOwnedToolResults));
            if (restricted)
                assert(row.restrictedCatalogSafe, 'Append file must preserve native restricted catalog');
            assert(!resume || sessionId === resume);
            for (const p of plugins) {
                assert(hooks[p] > 0, 'Owned plugin hook must execute');
                assert(calls.some(c => c.path === '/' + p && c.method === 'tools/call'), 'Owned plugin MCP must execute');
            }
            return sessionId;
        }
        const baseline = world('baseline');
        await turn('baseline', baseline);
        assert(!scenarios.at(-1).appendA && !scenarios.at(-1).appendB);
        const prompts = world('prompts'), session = await turn('append-fresh-A', prompts, { append: prompts.fileA });
        assert(scenarios.at(-1).appendA && !scenarios.at(-1).appendB, 'Fresh file append positive');
        await turn('append-resume-B', prompts, { append: prompts.fileB, resume: session });
        await turn('append-relaunch-B-with-plugin', prompts, { append: prompts.fileB, plugins: ['owned-files-dir'], resume: session });
        const dirs = world('directory');
        await turn('plugin-directory', dirs, { plugins: ['owned-files-dir'] });
        const zip = world('zip');
        await turn('plugin-zip', zip, { plugins: ['owned-files-zip'] });
        const both = world('both');
        await turn('plugins-directory-and-zip', both, { append: both.fileB, plugins: ['owned-files-dir', 'owned-files-zip'] });
        assert(!scenarios.at(-1).appendA && scenarios.at(-1).appendB);
        if (/^2[.]1[.]311(?:\s|$)/.test(pre.cliVersion)) {
            const restrictedWorld = world('restricted-append');
            await turn('restricted-append-file', restrictedWorld, { append: restrictedWorld.fileA, restricted: true });
            assert(scenarios.at(-1).appendA && !scenarios.at(-1).appendB);
        }
        assert.equal(hash(pre.binary), pre.binarySha256);
        assert.equal(errors.length, 0);
        for (const scenario of scenarios.filter(s => s.resumed))
            assert(scenario.appendA && !scenario.appendB, 'Native recorded prompt must retain the first file in these measured versions');
        for (const label of ['owned-files-dir', 'owned-files-zip']) {
            let refused = false;
            try {
                new ClaudeDriver({ cwd: both.cwd, nativeTools: 'none', pluginDirs: [both.plugins[label].input] });
            }
            catch (error) {
                refused = error instanceof Error && error.message.includes('pluginDirs') && error.message.includes('nativeTools');
            }
            assert(refused, 'Plugins must refuse before start under nativeTools none');
            pluginNoneRefusals.push({ plugin: label, refusedBeforeStart: true });
        }
    }
    catch (e) {
        failed = e instanceof Error ? e.message : 'unknown failure';
        if (failed.length > 200)
            failed = 'native observation failed; see per-scenario safe counters';
    }
    finally {
        if (driver)
            await driver.stop({ graceMs: 0 });
        for (const s of servers) {
            s.closeAllConnections?.();
            await new Promise(resolve => s.close(resolve));
        }
        const resolved = fs.realpathSync(ownRoot);
        assert.equal(path.dirname(resolved), parent);
        assert(path.basename(resolved).startsWith('prism-file-options-native-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    }
    const result = { realCli: true, cliVersion: pre.cliVersion, binarySha256: pre.binarySha256, failed, scenarios, nativeNoneAppendMeasured: scenarios.some(s => s.name === 'restricted-append-file'), pluginNoneRefusals, modelRequests: requests.length, blockedConnections: blocked.length, realAuthenticationOrProviderCalls: false, noFileOrPromptContentsLogged: true, ownedTempRemoved: !fs.existsSync(ownRoot) };
    return result;
}
