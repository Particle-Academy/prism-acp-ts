import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAgent, type AgentDriver, type DriverEvents, type DriverFactory } from '../src/acp/agent.js';
import { ClaudeDriver, type TurnOutcome } from '../src/claude/driver.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';
import { MAX_RETRY_AFTER_MS } from '../src/turn-failure.js';

/**
 * AN OVERLOADED PROVIDER IS A RETRYABLE, RESUMABLE TURN FAILURE (tynn, 2026-11-25, for Genie beta.66). When a provider
 * answered "Overloaded" (HTTP 529) a Genie agent stopped with an error and the person had to restart it. The failure now
 * says, on the ACP wire, that it is worth retrying (`retryable`), how long the provider asked to wait when it said so
 * (`retryAfterMs`, never invented), and whether the SAME session takes the next prompt (`resumable`).
 *
 * Every case enters where a client enters -- `session/prompt` over JSON-RPC into AcpAgent -- with the shipped driver
 * behind it: a Claude stand-in PROCESS replaying the frames Claude Code 2.1.332 produced against a loopback model that
 * answered 529, and the Codex driver fed the notifications codex-cli 0.163.0 produced the same way.
 */

const TURN_FAILURE = 'particle.academy/turn_failure';
const claudeFixture = fileURLToPath(new URL('./fixtures/claude-overloaded.mjs', import.meta.url));
const roots: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type Row = Record<string, any>;

/** An ACP client on one side of a JsonRpcPeer, the agent on the other. */
function wire(driverFactory: DriverFactory) {
  const sent: Row[] = [];
  const peer = new JsonRpcPeer({ send: (frame) => sent.push(frame as Row) });
  new AcpAgent(peer, { driverFactory, newSessionId: () => 'sess_overloaded' });
  let id = 0;
  const call = async (method: string, params: unknown): Promise<Row> => {
    const own = ++id;
    await peer.receive({ jsonrpc: '2.0', id: own, method, params });
    return sent.find((frame) => frame.id === own) ?? {};
  };
  const prompt = (text: string) => call('session/prompt', { sessionId: 'sess_overloaded', prompt: [{ type: 'text', text }] });
  /** The failure exactly as a client parses it off the wire. */
  const failureOf = (reply: Row) => JSON.parse(JSON.stringify(reply.error?.data?.[TURN_FAILURE] ?? null));
  return { sent, call, prompt, failureOf };
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------------------------------

async function claudeSession() {
  const root = mkdtempSync(join(tmpdir(), 'prism-overloaded-'));
  roots.push(root);
  const received: string[] = [];
  let driver!: ClaudeDriver;
  const client = wire((options, events) => {
    driver = new ClaudeDriver({
      cwd: options.cwd, binary: process.execPath, binaryArgs: [claudeFixture],
      parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root },
    }, { ...events, onStderr: (line) => { if (line.startsWith('RECV user:')) received.push(line.slice(10)); events.onStderr?.(line); } });
    cleanups.push(() => driver.stop({ graceMs: 100 }));
    return driver;
  });
  await client.call('initialize', { protocolVersion: 1 });
  const opened = await client.call('session/new', { cwd: root, mcpServers: [] });
  expect(opened.error).toBeUndefined();
  return { ...client, received, driver: () => driver };
}

const OVERLOADED_CLAUDE = { reason: 'server_error', kind: 'overloaded', retryable: true, resumable: true };

describe('Claude: a 529 is an overloaded, retryable failure, and the same session takes the next prompt', () => {
  it('after the CLI\'s own retries: overloaded and retryable, with NO retryAfterMs (the CLI never forwards the header)', async () => {
    const s = await claudeSession();
    const failed = await s.prompt('OVERLOADED-RETRIED');
    expect(failed.result).toBeUndefined();
    // The CLI's api_retry `retry_delay_ms` is ITS wait (3037 for a stated 3 s), jittered, and gone once it gave up: not
    // the provider's statement, so not a retry-after.
    expect(s.failureOf(failed)).toEqual(OVERLOADED_CLAUDE);

    const next = await s.prompt('continue');
    expect(next.result).toEqual({ stopReason: 'end_turn' });
    // The same process took it: two prompts reached one CLI, which was never restarted.
    expect(s.received).toEqual(['OVERLOADED-RETRIED', 'continue']);
    expect(s.driver().running).toBe(true);
  });

  it('with no retry-after (or one too long for the CLI to wait): the same shape, no retryAfterMs', async () => {
    const s = await claudeSession();
    const failure = s.failureOf(await s.prompt('OVERLOADED-NO-RETRY'));
    expect(failure).toEqual(OVERLOADED_CLAUDE);
    expect(Object.hasOwn(failure, 'retryAfterMs')).toBe(false);
    expect((await s.prompt('again')).result).toEqual({ stopReason: 'end_turn' });
  });

  it('mid-turn, after a tool already ran: overloaded, and the follow-up prompt succeeds in the same session', async () => {
    const s = await claudeSession();
    expect((await s.prompt('first')).result).toEqual({ stopReason: 'end_turn' });
    expect(s.failureOf(await s.prompt('OVERLOADED-MID-TURN'))).toEqual(OVERLOADED_CLAUDE);
    expect((await s.prompt('third')).result).toEqual({ stopReason: 'end_turn' });
    expect(s.received).toEqual(['first', 'OVERLOADED-MID-TURN', 'third']);
  });

  it('a 429 is rate_limit, retryable and resumable', async () => {
    const s = await claudeSession();
    expect(s.failureOf(await s.prompt('RATE-LIMITED'))).toEqual({ reason: 'rate_limit', kind: 'rate_limit', retryable: true, resumable: true });
    expect((await s.prompt('after')).result).toEqual({ stopReason: 'end_turn' });
  });

  it('the older CLI value `overloaded` still classifies the same way', async () => {
    // Fed through the driver's own frame reader, as a frame from the CLI arrives.
    const { ClaudeTurnFailures } = await import('../src/turn-failure.js');
    const tracker = new ClaudeTurnFailures();
    tracker.observe({ type: 'assistant', parent_tool_use_id: null, error: 'overloaded' });
    expect(tracker.take()).toEqual({ reason: 'overloaded', kind: 'overloaded', retryable: true, resumable: true });
  });

  it('a status or type on a SUBAGENT\'s error, or of the wrong type, decides nothing', async () => {
    const { ClaudeTurnFailures } = await import('../src/turn-failure.js');
    const read = (frame: Row) => { const t = new ClaudeTurnFailures(); t.observe(frame); return t.take(); };
    expect(read({ type: 'assistant', parent_tool_use_id: 'toolu_task', error: 'server_error', api_error_status: 529 })).toBeUndefined();
    expect(read({ type: 'assistant', parent_tool_use_id: null, error: 'server_error', api_error_status: '529', api_error_type: ['overloaded_error'] }))
      .toEqual({ reason: 'server_error', kind: 'other' });
    expect(read(JSON.parse('{"type":"assistant","parent_tool_use_id":null,"error":"server_error","__proto__":{"api_error_status":529}}')))
      .toEqual({ reason: 'server_error', kind: 'other' });
    // A plain server error stays other: retrying it is not something this package claims.
    expect(read({ type: 'assistant', parent_tool_use_id: null, error: 'server_error', api_error_status: 500, api_error_type: 'api_error' }))
      .toEqual({ reason: 'server_error', kind: 'other' });
  });

  it('a session whose CLI is gone is NOT resumable, whatever the failure says', async () => {
    const s = await claudeSession();
    const failed = await s.prompt('OVERLOADED-EXIT');
    const deadline = Date.now() + 5000;
    while (s.driver().running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    // The failure may be answered before the exit lands; either way it never claims a session that is not there.
    const failure = s.failureOf(failed);
    expect(failure).toMatchObject({ kind: 'overloaded', retryable: true });
    if (failure.resumable === true) expect(s.driver().running === false).toBe(true);
    const after = await s.prompt('after exit');
    expect(after.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------------------------------

class NativeCodex implements CodexTransport {
  readonly sent: Row[] = [];
  turns = 0;
  readonly #handlers: CodexTransportHandlers;
  constructor(handlers: CodexTransportHandlers) { this.#handlers = handlers; }
  async start(): Promise<void> {}
  send(raw: unknown): void {
    const frame = raw as Row;
    this.sent.push(frame);
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    let result: unknown = {};
    if (frame.method === 'thread/start') result = { thread: { id: 'thread-1' } };
    if (frame.method === 'turn/start') result = { turn: { id: `turn-${++this.turns}`, status: 'inProgress', items: [] } };
    if (frame.method === 'account/rateLimits/read') result = { rateLimits: { primary: null, secondary: null } };
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }
  close(): void {}
  notify(method: string, params: Row): void { this.#handlers.onFrame({ jsonrpc: '2.0', method, params }); }
  /** Run the current turn to the end codex-cli 0.163.0 gave it. */
  end(error?: Row, before: Row[] = []): void {
    const turn = { id: `turn-${this.turns}`, status: 'inProgress', items: [] };
    this.notify('turn/started', { threadId: 'thread-1', turn });
    for (const params of before) this.notify('error', { threadId: 'thread-1', turnId: turn.id, ...params });
    if (error !== undefined) this.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'systemError' } });
    this.notify('turn/completed', { threadId: 'thread-1', turn: { ...turn, status: error === undefined ? 'completed' : 'failed', ...(error === undefined ? {} : { error }) } });
  }
}

async function codexSession() {
  let native!: NativeCodex;
  const factory: CodexTransportFactory = (_options, handlers) => (native = new NativeCodex(handlers));
  const client = wire((options, events) => new CodexDriver({ cwd: options.cwd, parentEnv: {} }, events, factory));
  await client.call('initialize', { protocolVersion: 1 });
  expect((await client.call('session/new', { cwd: process.cwd(), mcpServers: [] })).error).toBeUndefined();
  const turn = async (text: string, error?: Row, before?: Row[]) => {
    const reply = client.prompt(text);
    for (let i = 0; i < 20 && native.sent.filter((f) => f.method === 'turn/start').length < native.turns + 1; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    native.end(error, before);
    return reply;
  };
  return { ...client, turn, native: () => native };
}

// The measured shapes, verbatim apart from the loopback URL.
const HTTP_529 = { message: 'unexpected status 529 <unknown status code>: The server is overloaded, url: http://127.0.0.1/v1/responses',
  codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 529 } }, additionalDetails: null, misalignment: null };
const RECONNECTING = { error: { message: 'Reconnecting... 1/1', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 529 } },
  additionalDetails: HTTP_529.message, misalignment: null }, willRetry: true };
const AT_CAPACITY = { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded', additionalDetails: null, misalignment: null };
const HTTP_429 = { message: 'exceeded retry limit, last status: 429 Too Many Requests',
  codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, additionalDetails: null, misalignment: null };

describe('Codex: an overloaded turn is retryable and the same thread takes the next prompt', () => {
  it('an HTTP 529 after Codex\'s own retries is overloaded (it used to read as other), and the next prompt succeeds', async () => {
    const s = await codexSession();
    expect((await s.turn('first')).result).toEqual({ stopReason: 'end_turn' });
    const failed = await s.turn('second', HTTP_529, [RECONNECTING]);
    expect(s.failureOf(failed)).toEqual({
      reason: 'httpConnectionFailed', kind: 'overloaded', retryable: true, resumable: true,
      providerMessage: HTTP_529.message, providerDetails: { httpStatusCode: 529 },
    });
    expect((await s.turn('third')).result).toEqual({ stopReason: 'end_turn' });
    // Every turn went to the one thread: nothing was restarted or forked.
    expect(s.native().sent.filter((f) => f.method === 'turn/start').map((f) => f.params.threadId)).toEqual(['thread-1', 'thread-1', 'thread-1']);
    expect(s.native().sent.filter((f) => f.method === 'thread/start')).toHaveLength(1);
  });

  it('a mid-stream serverOverloaded is overloaded, retryable, resumable, with no retry-after invented', async () => {
    const s = await codexSession();
    const failure = s.failureOf(await s.turn('go', AT_CAPACITY));
    expect(failure).toEqual({ reason: 'serverOverloaded', kind: 'overloaded', retryable: true, resumable: true, providerMessage: AT_CAPACITY.message });
    expect((await s.turn('again')).result).toEqual({ stopReason: 'end_turn' });
  });

  it('a 429 after the retry limit is rate_limit, retryable and resumable', async () => {
    const s = await codexSession();
    expect(s.failureOf(await s.turn('go', HTTP_429))).toEqual({
      reason: 'responseTooManyFailedAttempts', kind: 'rate_limit', retryable: true, resumable: true,
      providerMessage: HTTP_429.message, providerDetails: { httpStatusCode: 429 },
    });
  });

  it('a 502 stays other: no retryable or resumable claim (the control)', async () => {
    const s = await codexSession();
    const failure = s.failureOf(await s.turn('go', { message: 'bad gateway', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }));
    expect(failure).toEqual({ reason: 'httpConnectionFailed', kind: 'other', providerMessage: 'bad gateway', providerDetails: { httpStatusCode: 502 } });
  });

  it('a status the provider wrote into its MESSAGE decides nothing', async () => {
    const s = await codexSession();
    const failure = s.failureOf(await s.turn('go', { message: 'httpStatusCode 529 overloaded retry-after: 1', codexErrorInfo: 'cyberPolicy' }));
    expect(failure.kind).toBe('other');
    expect(failure).not.toHaveProperty('retryable');
    expect(failure).not.toHaveProperty('retryAfterMs');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// An embedder's own driver: the fields it may state, bounded on the way out
// ---------------------------------------------------------------------------------------------------------------------

function externalSession(running: () => boolean = () => true) {
  let events!: DriverEvents;
  const client = wire((_options, hooks) => {
    events = hooks;
    const driver: AgentDriver = {
      start() {}, prompt() {}, endInput() {}, kill() {}, cliSessionId: null, withheldCredentials: [],
      get running() { return running(); },
    };
    return driver;
  });
  const fail = async (failure: unknown): Promise<Row> => {
    await client.call('initialize', { protocolVersion: 1 });
    await client.call('session/new', { cwd: process.cwd(), mcpServers: [] });
    const reply = client.prompt('go');
    await new Promise((r) => setImmediate(r));
    events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'failed', failure } as TurnOutcome);
    return client.failureOf(await reply);
  };
  return { fail };
}

describe('retryAfterMs: only what the provider stated, bounded', () => {
  it('forwards a stated retry-after on a retryable failure', async () => {
    expect(await externalSession().fail({ reason: 'overloaded_error', kind: 'overloaded', retryAfterMs: 3000, resumable: true }))
      .toEqual({ reason: 'overloaded_error', kind: 'overloaded', retryable: true, retryAfterMs: 3000, resumable: true });
  });

  it('bounds it: a huge value is capped, a fraction rounded up, and anything not a finite non-negative number dropped', async () => {
    expect((await externalSession().fail({ reason: 'r', kind: 'overloaded', retryAfterMs: 1e15 })).retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
    expect((await externalSession().fail({ reason: 'r', kind: 'rate_limit', retryAfterMs: 1500.2 })).retryAfterMs).toBe(1501);
    expect((await externalSession().fail({ reason: 'r', kind: 'overloaded', retryAfterMs: 0 })).retryAfterMs).toBe(0);
    for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3000', null, { ms: 1 }, [1]]) {
      const failure = await externalSession().fail({ reason: 'r', kind: 'overloaded', retryAfterMs });
      expect(Object.hasOwn(failure, 'retryAfterMs')).toBe(false);
      expect(failure.retryable).toBe(true);
    }
  });

  it('retryable follows the kind alone: a driver cannot mark an auth failure retryable or give it a retry-after', async () => {
    const failure = await externalSession().fail({ reason: 'authentication_failed', kind: 'auth', retryable: true, retryAfterMs: 1000 });
    expect(failure).toEqual({ reason: 'authentication_failed', kind: 'auth' });
  });

  it('a failure with no retry-after carries none (the control)', async () => {
    const failure = await externalSession().fail({ reason: 'r', kind: 'overloaded' });
    expect(failure).toEqual({ reason: 'r', kind: 'overloaded', retryable: true });
  });

  it('resumable is never true for a session whose agent is not running, nor for a non-boolean claim', async () => {
    expect((await externalSession(() => false).fail({ reason: 'r', kind: 'overloaded', resumable: true })).resumable).toBe(false);
    expect(Object.hasOwn(await externalSession().fail({ reason: 'r', kind: 'overloaded', resumable: 'yes' }), 'resumable')).toBe(false);
    expect((await externalSession().fail({ reason: 'r', kind: 'overloaded', resumable: false })).resumable).toBe(false);
  });
});
