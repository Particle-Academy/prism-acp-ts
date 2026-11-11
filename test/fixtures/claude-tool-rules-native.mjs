import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Actual CLI permission evaluation; synthetic model over owned loopback, never a real account. */
export async function probeClaudeToolRules(binary, claudeArgs) {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-tool-rules-'));
  const command = 'echo g258, comma space';
  const rule = `Bash(${command})`;
  const binarySha256 = hash(binary);
  const scenarios = [];
  const blocked = [];
  const servers = [];
  let child;
  // An allowlist environment and a disposable home: no inherited login, configuration, startup hooks or real key.
  const env = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    PATH: process.env.PATH, HOME: own, USERPROFILE: own, APPDATA: own, LOCALAPPDATA: own,
    TEMP: own, TMP: own, CLAUDE_CONFIG_DIR: own,
    ANTHROPIC_API_KEY: 'owned-g258-synthetic-fixture-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH ?? 'C:/Program Files/Git/bin/bash.exe' } : {}),
  };
  const listen = async handler => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  };
  try {
    const proxy = await listen((request, response) => {
      blocked.push(request.method); request.resume(); response.writeHead(502); response.end();
    });
    proxy.on('connect', (_request, socket) => {
      blocked.push('CONNECT'); socket.end('HTTP/1.1 502 Blocked\r\n\r\n');
    });
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    Object.assign(env, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost',
      http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, no_proxy: '127.0.0.1,localhost' });
    const version = spawnSync(binary, ['--version'], { cwd: own, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(version.status, 0, 'Native CLI version must be observable');
    const cliVersion = version.stdout.trim();
    assert(/^2\.1\.(203|295|311|322) \(Claude Code\)$/.test(cliVersion), 'Measure a new CLI before adding it to this fixture matrix');

    for (const scenario of [
      { name: 'broad-positive', allowed: ['Bash'], denied: [], executes: true },
      { name: 'individual-allow', allowed: [rule, 'Read'], denied: [], executes: true },
      { name: 'individual-deny', allowed: ['Bash'], denied: [rule, 'Read'], executes: false },
    ]) {
      const cwd = path.join(own, scenario.name); fs.mkdirSync(cwd);
      const config = path.join(cwd, 'config'); fs.mkdirSync(config);
      let requests = 0, otherRequests = 0, toolResult = null, protocolError = null;
      const model = await listen((request, response) => {
        void (async () => {
          let raw = '';
          for await (const chunk of request) { raw += chunk; assert(Buffer.byteLength(raw) < 2_000_000); }
          const url = new URL(request.url, 'http://127.0.0.1');
          if (!url.pathname.endsWith('/messages')) {
            otherRequests++; response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(url.pathname.endsWith('/count_tokens') ? { input_tokens: 10 } : { data: [], has_more: false })); return;
          }
          assert(++requests <= 3, 'Finite model fixture');
          const input = JSON.parse(raw);
          const results = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
            .filter(content => content.type === 'tool_result' && content.tool_use_id === 'toolu_g258_echo');
          if (results.length) { assert.equal(results.length, 1); toolResult = results[0]; }
          const content = toolResult
            ? { type: 'text', text: 'Owned permission fixture finished.' }
            : { type: 'tool_use', id: 'toolu_g258_echo', name: 'Bash', input: { command, description: 'Harmless local parser probe' } };
          const stop = toolResult ? 'end_turn' : 'tool_use';
          const message = { id: 'msg_g258', type: 'message', role: 'assistant', model: input.model,
            content: [content], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
          if (!input.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const emit = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
          emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
          emit('content_block_start', { index: 0, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } });
          emit('content_block_delta', { index: 0, delta: content.type === 'text'
            ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
          emit('content_block_stop', { index: 0 });
          emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
          emit('message_stop', {}); response.end();
        })().catch(() => { protocolError = 'owned-model-protocol'; response.writeHead(500); response.end('{}'); });
      });
      const args = ['--bare', ...claudeArgs({ cwd, model: 'sonnet', permissionMode: 'dontAsk',
        allowedTools: scenario.allowed, disallowedTools: scenario.denied }), '--no-session-persistence', '--tools', 'Bash'];
      let stdout = '', stderr = '', timedOut = false;
      child = spawn(binary, args, { cwd, env: { ...env, CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}` }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const consume = (stream, append) => stream.on('data', bytes => {
        append(bytes.toString());
        if (stdout.length + stderr.length > 4_000_000) { timedOut = true; child.kill('SIGKILL'); }
      });
      consume(child.stdout, text => { stdout += text; }); consume(child.stderr, text => { stderr += text; });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Run the supplied harmless echo once.' }] } }) + '\n');
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
      let exit;
      try { exit = await once(child, 'close'); } finally { clearTimeout(timer); }
      assert(!timedOut, 'Native permission probe must finish');
      assert.deepEqual(exit, [0, null], 'Native CLI must exit successfully');
      assert.equal(protocolError, null);
      assert.equal(requests, 2, 'Both native tool result and final completion must traverse the fixture');
      const frames = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const result = frames.findLast(frame => frame.type === 'result');
      assert.equal(result?.subtype, 'success');
      const denied = (result.permission_denials ?? []).some(denial => denial.tool_name === 'Bash' && denial.tool_input?.command === command);
      const output = typeof toolResult?.content === 'string' ? toolResult.content : JSON.stringify(toolResult?.content);
      const nativeTool = frames.find(frame => frame.type === 'user' && frame.message?.content?.some(
        content => content.type === 'tool_result' && content.tool_use_id === 'toolu_g258_echo'))?.tool_use_result;
      // The model-facing content can append a native cwd-reset notice. The native result separates stdout/stderr.
      const executed = toolResult?.is_error === false && nativeTool?.stdout?.trim() === 'g258, comma space'
        && nativeTool?.interrupted === false;
      if (executed !== scenario.executes || denied !== !scenario.executes) {
        console.error(JSON.stringify({ nativeRuleFailure: { cliVersion, scenario: scenario.name, args, toolResult,
          permissionDenials: result.permission_denials, resultSubtype: result.subtype, stdout, stderr } }));
      }
      assert.equal(executed, scenario.executes, 'Native execution must match the exact permission rule');
      assert.equal(denied, !scenario.executes, 'A DENY must identify the exact tool call, not an unrelated startup failure');
      scenarios.push({ name: scenario.name, args, requests, otherRequests, executed, denied, exit,
        stdoutSha256: createHash('sha256').update(stdout).digest('hex'), stderrSha256: createHash('sha256').update(stderr).digest('hex') });
      child = null;
    }
    assert.equal(hash(binary), binarySha256);
    assert.deepEqual(blocked, [], 'No non-loopback network attempt is allowed');
    return { cliVersion, binarySha256, rule, scenarios, blocked, realProviderRequests: 0, syntheticCostIsNotSpend: true };
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert(path.resolve(own).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(own, { recursive: true, force: true });
  }
}
