import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexDriver, type CodexDriverOptions } from '../../src/codex/driver.js';
import { restrictedToolConfig } from '../../src/codex/native-tools.js';
import { StdioCodexTransport } from '../../src/codex/transport.js';
import type { TurnOutcome } from '../../src/claude/driver.js';
import { advertisedTools } from './codex-tool-surface.js';

type Row = Record<string, any>;
export interface ProbeOptions {
  model: string;
  nativeTools?: CodexDriverOptions['nativeTools'];
  manualRestriction?: boolean;
  /** Positive control only: prove a supplied CodeMode script can execute when its host is enabled. */
  codeModeHost?: boolean;
  inheritedForeign?: boolean;
  suppliedForeign?: boolean;
  noMcp?: boolean;
  resumeSessionId?: string;
  reuseHome?: string;
  replaceVersion?: string;
  calls?: readonly Row[];
  executionControl?: boolean;
  inheritedFeatures?: Record<string, unknown>;
  inheritedSettings?: Record<string, unknown>;
}

function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part.length > 0 && !part.startsWith('..') && !isAbsolute(part);
}

function toml(data: Row, path: string[] = []): string {
  const scalar = Object.entries(data).filter(([, value]) => value === null || typeof value !== 'object' || Array.isArray(value));
  const tables = Object.entries(data).filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value));
  let text = path.length ? `[${path.map((part) => JSON.stringify(part)).join('.')}]\n` : '';
  for (const [key, value] of scalar) text += `${JSON.stringify(key)} = ${JSON.stringify(value)}\n`;
  for (const [key, value] of tables) text += '\n' + toml(value, [...path, key]);
  return text;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** All model responses and MCP servers belong to this finite probe. Never uses a real login or provider. */
export async function openCodexToolProbe(options: ProbeOptions) {
  const repo = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const parent = join(repo, '.native-tools-probes'); mkdirSync(parent, { recursive: true });
  assert(inside(repo, realpathSync(parent)), 'Probe parent must remain in its worktree');
  const root = mkdtempSync(join(parent, 'run-'));
  const nonce = basename(root);
  const home = options.reuseHome ?? join(root, 'home'); mkdirSync(home, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), 'prism-codex-tools-cwd-'));
  const temporaryParent = realpathSync(tmpdir());
  const receipt = join(root, 'mcp-receipts.jsonl');
  const mcpScript = fileURLToPath(new URL('./codex-native-tools-mcp.mjs', import.meta.url));
  const requests: Row[] = [], sent: Row[] = [], problems: string[] = [], unexpected: string[] = [], blockedConnections: string[] = [];
  let endTurn: ((outcome: TurnOutcome) => void) | undefined;
  let reportedAgent: string | undefined;
  let effectiveConfig: Row | undefined;
  let driver: CodexDriver | undefined, cleaned = false;
  const server = createServer((request, response) => { void (async () => {
    try {
      assert(!request.headers['content-encoding'], 'Probe requires uncompressed auditable requests');
      assert(request.headers.authorization === undefined || request.headers.authorization === 'Bearer prism-dummy-not-a-real-api-key', 'Unexpected provider authorization');
      if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
      if (request.url?.startsWith('/chatgpt/') || request.url?.startsWith('/openai/')) { response.writeHead(401); response.end('{"error":"local dummy account"}'); return; }
      if (request.url !== '/v1/responses' || request.method !== 'POST') { unexpected.push('unexpected route'); response.writeHead(403); response.end(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 8 * 1024 * 1024, 'Model request bound'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Row;
      requests.push(body); assert(requests.length <= 8, 'Model fixture retry bound');
      const id = `prism-response-${requests.length}`;
      const scripted = options.calls?.[requests.length - 1];
      const item = scripted ? { id: `${nonce}-call-${requests.length}`, call_id: `${nonce}-probe-${requests.length}`, ...scripted }
        : { type: 'message', id: `${id}-message`, role: 'assistant', content: [{ type: 'output_text', text: 'Local fixture complete' }] };
      const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { unexpected.push(error instanceof Error ? error.message : 'fixture error'); response.destroy(); }
  })(); });
  // Rust HTTP clients use this non-forwarding proxy; auxiliary CONNECTs are recorded and locally refused.
  server.on('connect', (request, socket) => {
    // Some CLI startup/telemetry clients try their compiled-in hosts even with an empty home.
    // The fixture never tunnels them: they connect ONLY to this local rejecting proxy.
    blockedConnections.push(request.url ?? '<unknown>'); socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixtureServer = (name: string) => ({ command: process.execPath, args: [mcpScript, receipt, name] });
  const configuration: Row = {
    ...(options.manualRestriction ? restrictedToolConfig(undefined) : {}),
    model: options.model, model_provider: 'prism_fake', check_for_update_on_startup: false,
    chatgpt_base_url: origin + '/chatgpt', openai_base_url: origin + '/openai/v1',
    features: { ...(options.manualRestriction ? restrictedToolConfig(undefined).features as Row : {}),
      ...(options.codeModeHost === undefined ? {} : { code_mode_host: options.codeModeHost }),
      ...options.inheritedFeatures,
      enable_request_compression: false, api_key_model_discovery: false },
    model_providers: { prism_fake: { name: 'Prism local fake provider', base_url: origin + '/v1', wire_api: 'responses',
      env_key: 'PRISM_FAKE_KEY', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
    analytics: { enabled: false }, feedback: { enabled: false },
    ...options.inheritedSettings,
    ...(options.inheritedForeign ? { mcp_servers: { foreign: fixtureServer('foreign') } } : {}),
  };
  writeFileSync(join(home, 'config.toml'), toml(configuration));
  const parentEnv: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec']) if (process.env[key]) parentEnv[key] = process.env[key]!;
  Object.assign(parentEnv, { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    PRISM_FAKE_KEY: 'prism-dummy-not-a-real-api-key', HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: '127.0.0.1,localhost,::1' });
  const cleanup = async (keepHome = false) => {
    if (cleaned) {
      if (!keepHome && existsSync(root)) {
        assert(inside(realpathSync(parent), realpathSync(root)), 'Resolved cleanup target must remain inside its owned worktree parent');
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      return;
    }
    cleaned = true;
    try {
      if (driver) {
        const stop = await driver.stop({ graceMs: 500 });
        assert(stop.verified && stop.empty && stop.survivors === 0, 'Native process tree must be verified empty');
        console.info(JSON.stringify({ codexToolProbe: true, model: options.model, reportedAgent,
          surface: requests.length ? advertisedTools(requests[0]) : [], featureConfig: effectiveConfig?.features,
          toolConfig: effectiveConfig?.tools, configuredFields: effectiveConfig ? Object.keys(effectiveConfig).filter((key) => effectiveConfig![key] !== null) : [],
          problems, blockedConnections, stop }));
      }
    } finally {
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      assert(inside(temporaryParent, realpathSync(cwd)), 'Resolved cleanup target must remain inside its temporary parent');
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      assert(inside(realpathSync(parent), realpathSync(root)), 'Resolved cleanup target must remain inside its owned worktree parent');
      if (!keepHome) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  try {
    const servers = [...(options.noMcp ? [] : [{ name: 'owned', ...fixtureServer('owned'), env: [] }]),
      ...(options.suppliedForeign ? [{ name: 'foreign', ...fixtureServer('foreign'), env: [] }] : [])];
    driver = new CodexDriver({ cwd, binary: process.env.PRISM_ACP_CODEX_BINARY ?? 'codex', parentEnv, allowEnv: ['PRISM_FAKE_KEY'],
      model: options.model, ...(options.nativeTools === undefined ? {} : { nativeTools: options.nativeTools }),
      mcpServers: servers, mcpToolApproval: Object.fromEntries(servers.map((entry) => [entry.name, 'approve' as const])),
      approvalPolicy: options.executionControl ? 'never' : 'untrusted', sandbox: options.executionControl ? 'danger-full-access' : 'read-only', turnInactivityTimeoutMs: 15000,
      ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
    }, { onProtocolError: (problem) => problems.push(problem), onTurnEnd: (outcome) => endTurn?.(outcome) }, (launch, handlers) => {
      const real = new StdioCodexTransport(launch, { ...handlers, onFrame: (raw) => {
        const frame = raw as Row;
        if (frame.result?.config) effectiveConfig = frame.result.config;
        if (typeof frame.result?.userAgent === 'string') {
          reportedAgent = frame.result.userAgent;
          if (options.replaceVersion) { handlers.onFrame({ ...frame, result: { ...frame.result, userAgent: `prism-probe/${options.replaceVersion} (injected version)` } }); return; }
        }
        handlers.onFrame(raw);
      } });
      return { start: () => real.start(), send: (raw) => { sent.push(raw as Row); real.send(raw); },
        close: (signal) => real.close(signal), stop: (settings) => real.stop(settings), get processTree() { return real.processTree; } };
    });
    driver.start(); await bounded(driver.ready, 20000, 'Native fixture startup timeout');
    return {
      driver, requests, sent, problems, unexpected, blockedConnections, home, root, cleanup,
      resources: () => existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row) : [],
      outputs: () => requests.flatMap((body) => body.input.filter((item: Row) => typeof item.call_id === 'string' && item.call_id.startsWith(nonce + '-probe-') && (item.type === 'function_call_output' || item.type === 'custom_tool_call_output'))).map((item: Row) => JSON.stringify(item.output)).join('\n'),
      turn: async () => {
        assert.deepEqual(problems, [], 'Native startup must succeed before a probe turn');
        const done = new Promise<TurnOutcome>((resolve) => { endTurn = resolve; });
        driver!.prompt('This is an owned local fake-provider probe; return the scripted deterministic response.');
        const outcome = await bounded(done, 25000, 'Native fixture turn timeout');
        assert.equal(outcome.isError, false, 'Native fixture turn must complete');
        assert.deepEqual(unexpected, [], 'All HTTP stays on the local fixture');
        assert(blockedConnections.length <= 16, 'Bounded rejected auxiliary network attempts');
        return outcome;
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
