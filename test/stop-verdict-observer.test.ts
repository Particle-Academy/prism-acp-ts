import { describe, expect, it, vi } from 'vitest';
import { ClaudeCancelStateError, ClaudeDriver } from '../src/claude/driver.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport } from '../src/codex/transport.js';
import { AcpAgent, type DriverEvents } from '../src/acp/agent.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';
import type { StopVerdict } from '../src/index.js';

const finalVerdict: StopVerdict = { graceful: false, empty: true, survivors: 0, verified: true };
const unknownVerdict: StopVerdict = { graceful: false, empty: false, survivors: null, verified: false };
function setup(observer: (verdict: StopVerdict) => void, stop?: CodexTransport['stop']) {
  const close = vi.fn();
  const factory: CodexTransportFactory = (_options, handlers) => ({
    start: async () => {}, close,
    ...(stop === undefined ? {} : { stop }),
    send: (raw: unknown) => {
      const frame = raw as { id?: number; method?: string };
      if (frame.id === undefined) return;
      const result = frame.method === 'thread/start' ? { thread: { id: 'owned-thread' }, model: 'owned-model' }
        : frame.method === 'model/list' ? { data: [], nextCursor: null } : {};
      queueMicrotask(() => handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
    },
  });
  const driver = new CodexDriver({ cwd: process.cwd(), parentEnv: {} }, { onStopVerdict: observer }, factory);
  return { driver, close };
}
describe('stop verdict observation is additive and cannot alter native truth', () => {
  it('shares one pending stop and emits exactly once only after native settlement', async () => {
    let resolve!: (value: StopVerdict) => void;
    const native = new Promise<StopVerdict>(done => { resolve = done; });
    const stop = vi.fn(() => native), observe = vi.fn();
    const { driver, close } = setup(observe, stop);
    driver.start(); await driver.modelState();
    const first = driver.stop({ graceMs: 12 }), second = driver.stop({ graceMs: 0 });
    expect(first).toBe(second);
    expect(stop).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledWith({ graceMs: 12 });
    expect(observe).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    resolve(finalVerdict);
    const result = await first;
    expect(result).toEqual(finalVerdict); expect(observe).toHaveBeenCalledExactlyOnceWith(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toBe(finalVerdict);
    expect(await driver.stop()).toBe(result); expect(stop).toHaveBeenCalledTimes(1);
  });
  it('isolates a throwing observer after cleanup and preserves the returned verdict', async () => {
    const stop = vi.fn(async () => finalVerdict);
    const observe = vi.fn(() => { throw new Error('owned observer failure'); });
    const { driver } = setup(observe, stop);
    driver.start(); await driver.modelState();
    await expect(driver.stop()).resolves.toEqual(finalVerdict);
    await expect(driver.stop()).resolves.toEqual(finalVerdict);
    expect(observe).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
  });
  it('never promotes an unreporting custom transport to verified empty', async () => {
    const observe = vi.fn(), { driver, close } = setup(observe);
    driver.start(); await driver.modelState();
    expect(await driver.stop()).toEqual(unknownVerdict);
    expect(await driver.stop()).toEqual(unknownVerdict);
    expect(observe).toHaveBeenCalledExactlyOnceWith(unknownVerdict); expect(close).toHaveBeenCalledTimes(1);
  });
  it('does not invent a successful verdict or event when native stop rejects', async () => {
    const failure = new Error('owned native observation failed');
    const observe = vi.fn(), stop = vi.fn(async () => { throw failure; });
    const { driver } = setup(observe, stop);
    driver.start(); await driver.modelState();
    await expect(driver.stop()).rejects.toBe(failure);
    await expect(driver.stop()).rejects.toBe(failure);
    expect(observe).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
  });
  it('preserves native empty:true with an unverified unknown count', async () => {
    const native = { graceful: false, empty: true, survivors: null, verified: false };
    const observe = vi.fn(), { driver } = setup(observe, async () => native);
    driver.start(); await driver.modelState();
    const result = await driver.stop();
    expect(result).toEqual(native); expect(result.verified).toBe(false); expect(result.survivors).toBeNull();
    expect(observe).toHaveBeenCalledExactlyOnceWith(result);
  });
  it('does not await an async observer and isolates its rejected promise', async () => {
    const observe = vi.fn(async () => { throw new Error('owned rejected observation'); });
    const { driver } = setup(observe, async () => finalVerdict);
    driver.start(); await driver.modelState();
    await expect(driver.stop()).resolves.toEqual(finalVerdict);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observe).toHaveBeenCalledTimes(1);
  });
  it('returns cleanup facts even when an observer promise never settles', async () => {
    const observe = vi.fn(() => new Promise<void>(() => {}));
    const { driver } = setup(observe, async () => finalVerdict);
    driver.start(); await driver.modelState();
    await expect(driver.stop()).resolves.toEqual(finalVerdict);
    expect(observe).toHaveBeenCalledTimes(1);
  });
  it('gives manually created uncertainty errors an immutable unknown snapshot', () => {
    const error = new ClaudeCancelStateError() as ClaudeCancelStateError & { stopVerdict?: StopVerdict };
    expect(error.code).toBe('claude_cancel_state_uncertain');
    expect(error.message).toBe('cancel state uncertain; driver stopped');
    expect(error.stopVerdict).toEqual(unknownVerdict); expect(Object.isFrozen(error.stopVerdict)).toBe(true);
  });
  it('observes repeated stop before a Claude process exists without starting one', async () => {
    const observe = vi.fn();
    const driver = new ClaudeDriver({ cwd: process.cwd(), parentEnv: {} }, { onStopVerdict: observe });
    const first = driver.stop(), second = driver.stop();
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ graceful: true, empty: true, survivors: 0, verified: true });
    expect(observe).toHaveBeenCalledTimes(1); expect(driver.processTree).toBeNull();
  });
});

describe('ACP host observation keeps session identity without a wire extension', () => {
  it('forwards each session and isolates observer exceptions from the caller', async () => {
    const sent: unknown[] = [], events: DriverEvents[] = [], seen: unknown[] = [];
    const peer = new JsonRpcPeer({ send: frame => sent.push(frame) });
    let sequence = 0;
    new AcpAgent(peer, {
      newSessionId: () => 'owned-session-' + ++sequence,
      onStopVerdict: (sessionId: string, verdict: StopVerdict) => { seen.push({ sessionId, verdict }); throw new Error('owned host observer failure'); },
      driverFactory: (_options, hooks) => {
        events.push(hooks);
        return { start() {}, prompt() {}, endInput() {}, kill() {}, cliSessionId: null, withheldCredentials: [] };
      },
    });
    await peer.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    for (let id = 2; id <= 3; id++) await peer.receive({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    expect(events).toHaveLength(2);
    const before = sent.length;
    for (const hooks of events) expect(() => (hooks as DriverEvents & { onStopVerdict?: (verdict: StopVerdict) => void }).onStopVerdict?.(finalVerdict)).not.toThrow();
    expect(seen).toEqual([{ sessionId: 'owned-session-1', verdict: finalVerdict }, { sessionId: 'owned-session-2', verdict: finalVerdict }]);
    expect(sent).toHaveLength(before);
  });
});
