import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeDriver, type TurnOutcome } from '../src/claude/driver.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { PING_TIMEOUT_DEFAULT_MS, PING_TIMEOUT_MAX_MS, PING_TIMEOUT_MIN_MS, pingTimeoutMs } from '../src/liveness.js';
import { META_RATE_LIMIT_READING } from '../src/meta.js';

/**
 * G-314 (Tynn #855): a host must tell a stalled provider from a busy one and offer Stop/Restart. Both drivers get
 * `ping()`, `lastFrameAt`, and (Codex) `running`. Every case enters where a host does -- the driver's own methods --
 * against a real child process for Claude (fixtures/claude-liveness.mjs) and a scripted app-server transport for Codex,
 * plus a real app-server stand-in process where `running` depends on the process itself.
 */

const fixture = fileURLToPath(new URL('./fixtures/claude-liveness.mjs', import.meta.url));
const roots: string[] = [];
const drivers: { stop: () => Promise<unknown> }[] = [];

const until = async (what: string, ready: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The driver mints a random id for a message streamed before the CLI names it; keep identity, drop the randomness. */
/** A rate-limit reading's `asOfMs` is the wall clock, so two runs differ there and must match everywhere else. */
const withoutReadingClock = (updates: unknown[]) => updates.map((update) => {
  const meta = (update as { _meta?: Record<string, unknown> })._meta;
  const reading = meta?.[META_RATE_LIMIT_READING] as Record<string, unknown> | undefined;
  return reading === undefined ? update : { ...(update as object), _meta: { ...meta, [META_RATE_LIMIT_READING]: { ...reading, asOfMs: 0 } } };
});

const minted = (updates: unknown[]) => {
  const seen = new Map<string, string>();
  return JSON.parse(JSON.stringify(updates).replace(/prism_msg_[0-9a-f-]{36}/g, id => seen.get(id) ?? (seen.set(id, `minted-${seen.size}`), seen.get(id)!))) as unknown[];
};

function ownedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'prism-liveness-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.stop();
  for (const root of roots.splice(0)) {
    const real = realpathSync(root);
    if (dirname(real) !== realpathSync(tmpdir()) || !basename(real).startsWith('prism-liveness-')) throw new Error('Owned fixture path changed');
    rmSync(real, { recursive: true, force: true });
  }
});

describe('ping timeout bounds', () => {
  it('clamps to the documented range and defaults a missing or non-finite value', () => {
    expect(pingTimeoutMs(undefined)).toBe(PING_TIMEOUT_DEFAULT_MS);
    expect(pingTimeoutMs(Number.NaN)).toBe(PING_TIMEOUT_DEFAULT_MS);
    expect(pingTimeoutMs(Number.POSITIVE_INFINITY)).toBe(PING_TIMEOUT_DEFAULT_MS);
    expect(pingTimeoutMs('5' as unknown)).toBe(PING_TIMEOUT_DEFAULT_MS);
    expect(pingTimeoutMs(-1)).toBe(PING_TIMEOUT_MIN_MS);
    expect(pingTimeoutMs(0)).toBe(PING_TIMEOUT_MIN_MS);
    expect(pingTimeoutMs(1e12)).toBe(PING_TIMEOUT_MAX_MS);
    expect(pingTimeoutMs(750)).toBe(750);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------------------------------

async function claude(mode: string, { waitForInit = true } = {}) {
  const root = ownedRoot();
  const outcomes: TurnOutcome[] = [], updates: unknown[] = [], received: string[] = [], errors: string[] = [];
  let exited = false;
  const driver = new ClaudeDriver({
    cwd: root, binary: process.execPath, binaryArgs: [fixture, mode],
    parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root },
  }, {
    onTurnEnd: value => outcomes.push(value),
    onUpdate: value => updates.push(value),
    onProtocolError: value => errors.push(value),
    onStderr: line => { if (line.startsWith('RECV ')) received.push(line.slice(5)); },
    onExit: () => { exited = true; },
  });
  drivers.push({ stop: () => driver.stop({ graceMs: 100 }) });
  driver.start();
  if (waitForInit) await driver.modelState();
  const pings = () => received.filter(line => line === 'control_request:mcp_status').length;
  const users = () => received.filter(line => line.startsWith('user:')).length;
  return { driver, outcomes, updates, received, errors, pings, users, exited: () => exited };
}

describe('ClaudeDriver.ping() (G-314)', () => {
  it('answers while idle, with one mcp_status control request and nothing else', async () => {
    const s = await claude('answer');
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(true);
    await until('the request to be logged', () => s.pings() === 1);
    await pause(100);
    expect(s.pings()).toBe(1);
    expect(s.users()).toBe(0);
    expect(s.received).toEqual(['control_request:initialize', 'control_request:mcp_status']);
    expect(s.outcomes).toEqual([]);
    expect(s.updates).toEqual([]);
    expect(s.driver.mcpServers).toBeNull();
    expect(s.errors).toEqual([]);
  }, 20000);

  it('counts an error answer as an answer: the CLI read and processed the request', async () => {
    const s = await claude('error');
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(true);
  }, 20000);

  it('answers mid-turn and leaves the turn end, its ordering and its usage exactly as they are without a ping', async () => {
    const run = async (withPing: boolean) => {
      const s = await claude('answer');
      const turnId = s.driver.prompt('SLOW');
      // The turn has started streaming and is holding: the ping lands inside it.
      await until('the first delta', () => s.updates.length > 0);
      let pinged: boolean | undefined;
      let endsWhenAnswered = -1;
      if (withPing) {
        pinged = await s.driver.ping({ timeoutMs: 5000 });
        endsWhenAnswered = s.outcomes.length;
      }
      await until('the turn end', () => s.outcomes.length === 1);
      await pause(100);
      return { s, turnId, pinged, endsWhenAnswered };
    };
    const plain = await run(false);
    const pinged = await run(true);

    expect(pinged.pinged).toBe(true);
    expect(pinged.endsWhenAnswered).toBe(0);
    // Same outcome, same updates in the same order, same usage; only the prompt's own id differs.
    const strip = ({ turnId: _turnId, ...rest }: TurnOutcome) => rest;
    expect(pinged.s.outcomes.map(strip)).toEqual(plain.s.outcomes.map(strip));
    expect(pinged.s.outcomes[0]?.turnId).toBe(pinged.turnId);
    expect(minted(pinged.s.updates)).toEqual(minted(plain.s.updates));
    expect(minted(pinged.s.updates)).toHaveLength(plain.s.updates.length);
    expect(pinged.s.updates.filter(u => (u as { sessionUpdate?: string }).sessionUpdate === 'usage_update')).toHaveLength(1);
    // The ping wrote one control request and no user message: nothing for the CLI to fold into the turn.
    expect(pinged.s.users()).toBe(1);
    expect(pinged.s.pings()).toBe(1);
    expect(pinged.s.errors).toEqual(plain.s.errors);
  }, 30000);

  it('a hung CLI gives false within the bound, and a second ping reuses the unanswered request', async () => {
    const s = await claude('hung');
    const before = s.driver.lastFrameAt;
    const started = Date.now();
    expect(await s.driver.ping({ timeoutMs: 200 })).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(2000);
    expect(await s.driver.ping({ timeoutMs: 1 })).toBe(false); // clamped up to the 100 ms floor, not 1 ms
    expect(Date.now() - started - elapsed).toBeGreaterThanOrEqual(90);
    await until('the request to be logged', () => s.pings() >= 1);
    await pause(100);
    expect(s.pings()).toBe(1);
    // Writing the ping is not a frame from the CLI.
    expect(s.driver.lastFrameAt).toBe(before);
    expect(s.driver.running).toBe(true);
  }, 20000);

  it('an answer under any other request id does not resolve the ping', async () => {
    const s = await claude('mismatch');
    expect(await s.driver.ping({ timeoutMs: 400 })).toBe(false);
    expect(s.pings()).toBe(1);
    expect(s.updates).toEqual([]);
  }, 20000);

  it('concurrent pings share one request and one answer', async () => {
    const s = await claude('answer');
    const first = s.driver.ping({ timeoutMs: 5000 });
    const second = s.driver.ping({ timeoutMs: 5000 });
    const third = s.driver.ping();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    await pause(150);
    expect(s.pings()).toBe(1);
    // A later ping is a new one.
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(true);
    await until('the second request', () => s.pings() === 2);
  }, 20000);

  it('a driver that is not started, or is stopped, gives false at once and writes nothing', async () => {
    const idle = new ClaudeDriver({ cwd: ownedRoot() });
    expect(await idle.ping()).toBe(false);

    const s = await claude('answer');
    void s.driver.stop({ graceMs: 100 });
    const started = Date.now();
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
    await until('the exit', s.exited);
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(false);
    expect(s.pings()).toBe(0);
  }, 20000);

  it('a ping in flight when the CLI exits resolves false then, not at its timeout', async () => {
    const s = await claude('hung');
    const ping = s.driver.ping({ timeoutMs: 30000 });
    await until('the request to be logged', () => s.pings() === 1);
    const started = Date.now();
    s.driver.kill();
    expect(await ping).toBe(false);
    expect(Date.now() - started).toBeLessThan(10000);
  }, 20000);

  it('lastFrameAt is undefined before the first frame and advances on frames, including a ping answer', async () => {
    const silent = await claude('silent', { waitForInit: false });
    expect(silent.driver.lastFrameAt).toBeUndefined();
    expect(await silent.driver.ping({ timeoutMs: 200 })).toBe(false);
    expect(silent.driver.lastFrameAt).toBeUndefined();

    const s = await claude('answer', { waitForInit: false });
    expect(s.driver.lastFrameAt).toBeUndefined();
    await s.driver.modelState();
    const afterInit = s.driver.lastFrameAt;
    expect(typeof afterInit).toBe('number');
    await pause(20);
    expect(await s.driver.ping()).toBe(true);
    const afterPing = s.driver.lastFrameAt!;
    expect(afterPing).toBeGreaterThan(afterInit!);
    await pause(20);
    s.driver.prompt('FAST');
    await until('the turn end', () => s.outcomes.length === 1);
    expect(s.driver.lastFrameAt!).toBeGreaterThan(afterPing);
  }, 20000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------------------------------

type ModelListMode = 'answer' | 'error' | 'hang' | 'mismatch';

class ScriptedAppServer implements CodexTransport {
  readonly sent: Record<string, unknown>[] = [];
  modelList: ModelListMode = 'answer';
  readonly #handlers: CodexTransportHandlers;
  constructor(handlers: CodexTransportHandlers) { this.#handlers = handlers; }
  async start(): Promise<void> {}
  send(raw: unknown): void {
    const frame = raw as { id?: number; method?: string };
    this.sent.push(raw as Record<string, unknown>);
    // A notification, or the driver's own reply to a server request: nothing to answer.
    if (frame.id === undefined || frame.method === undefined) return;
    const reply = (body: Record<string, unknown>) => queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, ...body }));
    switch (frame.method) {
      case 'thread/start': return reply({ result: { thread: { id: 'thread-owned' }, model: 'owned-model' } });
      case 'turn/start': return reply({ result: { turn: { id: 'turn-owned' } } });
      case 'model/list':
        if (frame.id === undefined || this.modelList === 'hang') return;
        if (this.modelList === 'error') return reply({ error: { code: -32600, message: 'Not initialized' } });
        if (this.modelList === 'mismatch') {
          queueMicrotask(() => {
            this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id! + 1000, result: { data: [], nextCursor: null } });
            this.#handlers.onFrame({ jsonrpc: '2.0', id: String(frame.id) + '-other', result: { data: [], nextCursor: null } });
            // A server REQUEST carrying the ping's id is not its answer.
            this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, method: 'owned/unknownRequest', params: {} });
          });
          return;
        }
        return reply({ result: { data: [], nextCursor: null } });
      default: return reply({ result: {} });
    }
  }
  frame(value: unknown): void { this.#handlers.onFrame(value); }
  exit(): void { this.#handlers.onExit(0, null); }
  close(): void {}
}

function codex() {
  let transport!: ScriptedAppServer;
  const factory: CodexTransportFactory = (_options, handlers) => (transport = new ScriptedAppServer(handlers));
  const updates: unknown[] = [], ends: TurnOutcome[] = [];
  const driver = new CodexDriver({ cwd: process.cwd(), parentEnv: {} }, {
    onUpdate: update => updates.push(update),
    onTurnEnd: outcome => ends.push(outcome),
  }, factory);
  drivers.push({ stop: () => driver.stop() });
  const pings = () => transport.sent.filter(frame => frame.method === 'model/list');
  return { driver, get transport() { return transport; }, updates, ends, pings };
}

const turnFrames = {
  started: { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-owned', turn: { id: 'turn-owned' } } },
  delta: { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-owned', turnId: 'turn-owned', itemId: 'msg-owned', delta: 'partial' } },
  usage: { jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'thread-owned', turnId: 'turn-owned', tokenUsage: {
    total: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, reasoningOutputTokens: 0 }, last: { totalTokens: 150 }, modelContextWindow: 200000 } } },
  completed: { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-owned', turn: { id: 'turn-owned', status: 'completed' } } },
};

describe('CodexDriver.ping() (G-314)', () => {
  it('answers while idle, with one model/list and nothing that touches the thread', async () => {
    const s = codex();
    s.driver.start();
    await s.driver.ready;
    const before = s.transport.sent.length;
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(true);
    const written = s.transport.sent.slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ method: 'model/list', params: { cursor: null, includeHidden: false } });
    expect(s.ends).toEqual([]);
  });

  it('counts a JSON-RPC error answer as an answer', async () => {
    const s = codex();
    s.driver.start();
    await s.driver.ready;
    s.transport.modelList = 'error';
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(true);
  });

  it('answers mid-turn and leaves the turn end, its ordering and its usage exactly as they are without a ping', async () => {
    const run = async (withPing: boolean) => {
      const s = codex();
      s.driver.start();
      await s.driver.ready;
      s.driver.prompt('work');
      await until('turn/start', () => s.transport.sent.some(frame => frame.method === 'turn/start'));
      await pause(0);
      s.transport.frame(turnFrames.started);
      s.transport.frame(turnFrames.delta);
      let pinged: boolean | undefined;
      if (withPing) {
        pinged = await s.driver.ping({ timeoutMs: 5000 });
        expect(s.ends).toEqual([]);
        expect(s.driver.steeringState.activeTurnId).toBe('turn-owned');
      }
      s.transport.frame(turnFrames.usage);
      s.transport.frame(turnFrames.completed);
      return { s, pinged };
    };
    const plain = await run(false);
    const pinged = await run(true);
    expect(pinged.pinged).toBe(true);
    expect(pinged.s.ends).toEqual(plain.s.ends);
    expect(pinged.s.ends).toHaveLength(1);
    expect(withoutReadingClock(pinged.s.updates)).toEqual(withoutReadingClock(plain.s.updates));
    expect(pinged.s.updates.filter(u => (u as { sessionUpdate?: string }).sessionUpdate === 'usage_update')).toHaveLength(1);
    // Exactly what the plain run wrote, plus the one model/list.
    const methods = (sent: Record<string, unknown>[]) => sent.map(frame => frame.method).filter(method => method !== 'model/list');
    expect(methods(pinged.s.transport.sent)).toEqual(methods(plain.s.transport.sent));
    expect(pinged.s.pings()).toHaveLength(1);
    expect(plain.s.pings()).toHaveLength(0);
  });

  it('a hung app-server gives false within the bound, and a second ping reuses the unanswered request', async () => {
    const s = codex();
    s.driver.start();
    await s.driver.ready;
    s.transport.modelList = 'hang';
    const before = s.driver.lastFrameAt;
    const started = Date.now();
    expect(await s.driver.ping({ timeoutMs: 200 })).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(2000);
    expect(await s.driver.ping({ timeoutMs: 1 })).toBe(false);
    expect(Date.now() - started - elapsed).toBeGreaterThanOrEqual(90);
    expect(s.pings()).toHaveLength(1);
    expect(s.driver.lastFrameAt).toBe(before);
  });

  it('an answer under any other id, or a server request reusing the id, does not resolve the ping', async () => {
    const s = codex();
    s.driver.start();
    await s.driver.ready;
    s.transport.modelList = 'mismatch';
    expect(await s.driver.ping({ timeoutMs: 300 })).toBe(false);
    expect(s.pings()).toHaveLength(1);
  });

  it('concurrent pings share one request and one answer', async () => {
    const s = codex();
    s.driver.start();
    await s.driver.ready;
    const first = s.driver.ping({ timeoutMs: 5000 });
    const second = s.driver.ping({ timeoutMs: 100 });
    expect(second).toBe(first);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(s.pings()).toHaveLength(1);
    expect(await s.driver.ping()).toBe(true);
    expect(s.pings()).toHaveLength(2);
  });

  it('a driver that is not started, or is stopped, gives false at once and writes nothing', async () => {
    const idle = codex();
    expect(await idle.driver.ping()).toBe(false);

    const s = codex();
    s.driver.start();
    await s.driver.ready;
    void s.driver.stop();
    const started = Date.now();
    expect(await s.driver.ping({ timeoutMs: 5000 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
    expect(s.pings()).toHaveLength(0);
  });

  it('a ping in flight when app-server exits resolves false then, not at its timeout', async () => {
    const s = codex();
    s.driver.start();
    await s.driver.ready;
    s.transport.modelList = 'hang';
    const ping = s.driver.ping({ timeoutMs: 30000 });
    const started = Date.now();
    s.transport.exit();
    expect(await ping).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s.driver.running).toBe(false);
    expect(await s.driver.ping()).toBe(false);
  });

  it('lastFrameAt is undefined before the first frame and advances on frames, including a ping answer', async () => {
    const s = codex();
    expect(s.driver.lastFrameAt).toBeUndefined();
    s.driver.start();
    expect(s.driver.lastFrameAt).toBeUndefined();
    await s.driver.ready;
    const afterReady = s.driver.lastFrameAt;
    expect(typeof afterReady).toBe('number');
    await pause(20);
    expect(await s.driver.ping()).toBe(true);
    const afterPing = s.driver.lastFrameAt!;
    expect(afterPing).toBeGreaterThan(afterReady!);
    await pause(20);
    s.transport.frame({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: {} } });
    expect(s.driver.lastFrameAt!).toBeGreaterThan(afterPing);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// running: Codex mirrors Claude, process for process
// ---------------------------------------------------------------------------------------------------------------------

const APP_SERVER = `
import { createInterface } from 'node:readline';
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return out({ jsonrpc: '2.0', id, result: {} });
  if (method === 'thread/start') return out({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-owned' }, model: 'owned-model' } });
  if (method === 'model/list') return out({ jsonrpc: '2.0', id, result: { data: [], nextCursor: null } });
  if (method === 'turn/start') {
    out({ jsonrpc: '2.0', id, result: { turn: { id: 'turn-owned' } } });
    out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-owned', turn: { id: 'turn-owned' } } });
    setTimeout(() => out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-owned', turn: { id: 'turn-owned', status: 'completed' } } }), 300);
    return;
  }
  out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not in this stand-in' } });
});
`;

describe('CodexDriver.running mirrors ClaudeDriver.running (G-314)', () => {
  it('false before start, true across turn start and end, still true while stop() waits, false once the process exits', async () => {
    const root = ownedRoot();
    const script = join(root, 'app-server.mjs');
    writeFileSync(script, APP_SERVER);
    const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root };

    const claudeEnds: TurnOutcome[] = [], codexEnds: TurnOutcome[] = [];
    const c = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, 'answer'], parentEnv: env },
      { onTurnEnd: o => claudeEnds.push(o) });
    const x = new CodexDriver({ cwd: root, binary: process.execPath, binaryArgs: [script], parentEnv: env },
      { onTurnEnd: o => codexEnds.push(o) });
    drivers.push({ stop: () => c.stop({ graceMs: 100 }) }, { stop: () => x.stop({ graceMs: 100 }) });
    const both = () => ({ claude: c.running, codex: x.running });

    const trace: Record<string, { claude: boolean; codex: boolean }> = {};
    trace.beforeStart = both();
    c.start(); x.start();
    trace.afterStart = both();
    await c.modelState(); await x.ready;
    trace.ready = both();
    c.prompt('SLOW'); x.prompt('work');
    await until('both turns to start', () => x.steeringState.activeTurnId === 'turn-owned');
    trace.midTurn = both();
    await until('both turn ends', () => claudeEnds.length === 1 && codexEnds.length === 1);
    trace.afterTurn = both();
    const stopping = [c.stop({ graceMs: 100 }), x.stop({ graceMs: 100 })];
    trace.stopCalled = both();
    await Promise.all(stopping);
    // Both read the supervised child's exit code, so both go false when the process has exited, not when stop() is
    // called. (CodexDriver's onExit event is not that moment: it fires when the DRIVER closes, at stop().)
    await until('both processes to exit', () => !c.running && !x.running);
    trace.exited = both();

    const yes = { claude: true, codex: true }, no = { claude: false, codex: false };
    expect(trace).toEqual({ beforeStart: no, afterStart: yes, ready: yes, midTurn: yes, afterTurn: yes, stopCalled: yes, exited: no });
  }, 30000);
});
