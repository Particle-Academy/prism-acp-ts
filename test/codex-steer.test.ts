import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexDriver, CODEX_DRIVER_CAPABILITIES } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import type { DriverEvents } from '../src/acp/agent.js';
import { AcpAgent } from '../src/acp/agent.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';
import { META_STEER, META_ACTIVE_TURN } from '../src/meta.js';
import { SteerInputError, SteerUnsupported, type SteerUpdate } from '../src/steer.js';

const id = (n = 1) => `a8b159e0-909e-4ca5-a8d4-${String(n).padStart(12, '0')}`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Native implements CodexTransport {
  closes = 0;
  readonly sent: Record<string, any>[] = [];
  readonly held: Record<string, any>[] = [];
  holdSteer = false;
  holdStart = false;
  partialWrite = false;
  steerError: { code: number; message: string; data?: unknown } | null = null;
  steerReply: unknown = { turnId: 'turn-one' };
  constructor(readonly handlers: CodexTransportHandlers, readonly version = '0.167.0') {}
  async start() {}
  send(raw: unknown) {
    const f = raw as Record<string, any>; this.sent.push(f);
    if (typeof f.id !== 'number' || !f.method) return;
    if (f.method === 'turn/steer') {
      if (this.partialWrite) throw new Error('SECRET partial write /private/path');
      if (this.holdSteer) { this.held.push(f); return; }
      if (this.steerError) { queueMicrotask(() => this.frame({ id: f.id, error: this.steerError })); return; }
    }
    if (f.method === 'turn/start' && this.holdStart) { this.held.push(f); return; }
    const result = f.method === 'initialize' ? { userAgent: `codex_cli_rs/${this.version} windows` }
      : f.method === 'thread/start' ? { thread: { id: 'thread-one' } }
      : f.method === 'thread/resume' ? { thread: { id: f.params.threadId } }
      : f.method === 'thread/turns/list' || f.method === 'thread/items/list' ? { data: [], nextCursor: null }
      : f.method === 'turn/start' ? { turn: { id: 'turn-one' } }
      : f.method === 'turn/steer' ? this.steerReply : {};
    queueMicrotask(() => this.frame({ id: f.id, result }));
  }
  frame(value: unknown) { this.handlers.onFrame(value); }
  notify(method: string, params: unknown) { this.frame({ method, params }); }
  item(clientId: unknown = id(), itemId = 'native-one', threadId = 'thread-one', turnId = 'turn-one', method = 'item/started') {
    this.notify(method, { threadId, turnId, item: { type: 'userMessage', id: itemId, clientId, content: [{ type: 'text', text: 'same text' }] } });
  }
  end(status = 'completed') { this.notify('turn/completed', { threadId: 'thread-one', turn: { id: 'turn-one', status } }); }
  close() { this.closes++; }
  get writes() { return this.sent.filter(f => f.method === 'turn/steer'); }
}
const drivers: CodexDriver[] = [];
afterEach(() => { for (const d of drivers.splice(0)) d.kill(); vi.useRealTimers(); });
async function setup(version = '0.167.0', events: DriverEvents = {}, startTurn = true) {
  let native!: Native;
  const updates: Record<string, any>[] = [], states: SteerUpdate[] = [];
  const driver = new CodexDriver({ cwd: process.cwd() }, {
    onUpdate: u => { updates.push(u); events.onUpdate?.(u); },
    onSteerUpdate: s => { states.push(s); events.onSteerUpdate?.(s); },
    ...Object.fromEntries(Object.entries(events).filter(([k]) => !['onUpdate', 'onSteerUpdate'].includes(k))),
  }, (_options, handlers) => (native = new Native(handlers, version)));
  drivers.push(driver); driver.start(); await driver.ready;
  if (startTurn) { driver.prompt('initial'); await tick(); }
  return { driver, native, updates, states };
}

describe('Codex explicit steering boundary', () => {
  it('pins native thread, turn and fresh ID; never starts or queues a second prompt', async () => {
    const { driver, native, updates } = await setup();
    expect(CODEX_DRIVER_CAPABILITIES.steer).toBe(true);
    expect(driver.steeringState).toMatchObject({ supported: true, cliVersion: '0.167.0', activeTurnId: 'turn-one' });
    expect(() => driver.prompt('ordinary mid-turn prompt')).toThrow('in flight');
    expect(await driver.steer('same text', { clientId: id(), expectedTurnId: 'turn-one' })).toEqual({ outcome: 'accepted', steerId: id(), turnId: 'turn-one' });
    expect(native.writes[0].params).toEqual({ threadId: 'thread-one', expectedTurnId: 'turn-one', clientUserMessageId: id(), input: [{ type: 'text', text: 'same text' }] });
    expect(native.sent.filter(f => f.method === 'turn/start')).toHaveLength(1);
    expect(driver.steerState(id())).toMatchObject({ kind: 'accepted', acceptance: 'accepted', final: false });
    expect(updates.some(u => u._meta?.[META_ACTIVE_TURN]?.activeTurnId === 'turn-one')).toBe(true);
  });
  it.each(['0.162.9', '0.160.0', '0.163.0-beta.1', 'garbage'])('refuses unsupported CLI %s without affecting prompts', async version => {
    const { driver, native } = await setup(version);
    await expect(driver.steer('x', { clientId: id() })).rejects.toBeInstanceOf(SteerUnsupported);
    expect(driver.steeringState.supported).toBe(false); expect(native.writes).toHaveLength(0);
    native.end(); await tick(); driver.prompt('ordinary next turn');
    expect(native.sent.filter(f => f.method === 'turn/start')).toHaveLength(2);
  });
  it.each(['0.163.0', '0.165.0', '0.167.0', '1.0.0'])('supports released CLI %s', async v => {
    const { driver } = await setup(v); expect((await driver.steer('x', { clientId: id() })).outcome).toBe('accepted');
  });
  it('refuses a missing method with typed steer_unsupported and remembers the runtime gate', async () => {
    const { driver, native } = await setup(); native.steerError = { code: -32601, message: 'SECRET key' };
    await expect(driver.steer('x', { clientId: id() })).rejects.toMatchObject({ code: 'steer_unsupported' });
    await expect(driver.steer('x', { clientId: id(2) })).rejects.toBeInstanceOf(SteerUnsupported);
    expect(native.writes).toHaveLength(1); expect(driver.steerState(id())).toMatchObject({ kind: 'not_delivered' });
  });
  it('never waits for startup, unknown turn IDs, a future turn or a closed session', async () => {
    const { driver, native } = await setup('0.167.0', {}, false);
    expect(await driver.steer('x', { clientId: id() })).toMatchObject({ reason: 'no_active_turn' });
    native.holdStart = true; driver.prompt('initial');
    expect(await driver.steer('x', { clientId: id() })).toMatchObject({ reason: 'turn_id_pending' });
    driver.kill(); expect(await driver.steer('x', { clientId: id() })).toMatchObject({ reason: 'session_closed' });
    expect(native.writes).toHaveLength(0);
  });
  it('rejects stale targets and invalid IDs/input before any write', async () => {
    const { driver, native } = await setup();
    expect(await driver.steer('x', { clientId: id(), expectedTurnId: 'old-turn' })).toMatchObject({ reason: 'turn_mismatch' });
    await expect(driver.steer('x', { clientId: 'SECRET invalid\n/path' })).rejects.toBeInstanceOf(SteerInputError);
    expect(await driver.steer([{ type: 'text', text: 'first' }, { type: 'audio', data: 'SECRET' }] as any, { clientId: id() })).toMatchObject({ reason: 'invalid_input' });
    expect(native.writes).toHaveLength(0);
  });
  it('rechecks cancellation after hostile input getters', async () => {
    const { driver, native } = await setup();
    const block = { type: 'text', get text() { void driver.cancel(); return 'x'; } };
    expect(await driver.steer([block], { clientId: id() })).toMatchObject({ reason: 'cancelling' });
    expect(native.writes).toHaveLength(0);
  });
  it('does not grant or settle a pending approval through steering', async () => {
    let decide!: (answer: any) => void;
    const { driver, native } = await setup('0.167.0', { onRequestPermission: () => new Promise(r => { decide = r; }) });
    native.frame({ id: 991, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-one', turnId: 'turn-one', itemId: 'cmd', command: 'CONTROLLED', availableDecisions: ['accept', 'decline'] } });
    expect((await driver.steer('x', { clientId: id() })).outcome).toBe('accepted');
    expect(native.sent.filter(f => f.id === 991)).toHaveLength(0);
    decide({ outcome: 'cancelled' }); await tick();
    expect(native.sent.filter(f => f.id === 991)).toHaveLength(1);
    expect(JSON.stringify(native.sent.find(f => f.id === 991))).not.toContain('accept');
    native.item(); expect(driver.steerState(id())).toMatchObject({ kind: 'observed' });
  });
  it('cancel-first refuses before write; steer-first preserves its named interrupted outcome', async () => {
    const a = await setup(); await a.driver.cancel();
    expect(await a.driver.steer('x', { clientId: id() })).toMatchObject({ reason: 'cancelling' }); expect(a.native.writes).toHaveLength(0);
    const b = await setup(); await b.driver.steer('x', { clientId: id() }); await b.driver.cancel(); b.native.end('interrupted'); await tick();
    expect(b.driver.steerState(id())).toMatchObject({ kind: 'turn_ended_unobserved', turnStatus: 'interrupted', final: true });
  });
  it('an uncertain interrupt reply cannot reopen steering before native turn end', async () => {
    const { driver, native } = await setup(); const send = native.send.bind(native);
    native.send = raw => { if ((raw as any).method === 'turn/interrupt') throw new Error('uncertain partial interrupt'); send(raw); };
    await expect(driver.cancel()).rejects.toThrow('turn/interrupt');
    expect(await driver.steer('x', { clientId: id() })).toMatchObject({ reason: 'cancelling' });
    expect(native.writes).toHaveLength(0);
  });
});

describe('retained per-steer lifecycle', () => {
  it('observes once by exact clientId/thread/turn, not identical content or notification count', async () => {
    const { driver, native, states } = await setup(); await driver.steer('same text', { clientId: id() }); await driver.steer('same text', { clientId: id(2) });
    native.item(id(2), 'two'); native.item(id(2), 'two', 'thread-one', 'turn-one', 'item/completed');
    expect(driver.steerState(id())).toMatchObject({ kind: 'accepted' });
    expect(driver.steerState(id(2))).toMatchObject({ kind: 'observed', nativeItemId: 'two' });
    expect(states.filter(s => s.kind === 'observed')).toHaveLength(1);
    native.item(id(), 'one'); expect(driver.steerState(id())).toMatchObject({ kind: 'observed', nativeItemId: 'one' });
  });
  it('retains item-before-reply observation independently of acceptance', async () => {
    const { driver, native } = await setup(); native.holdSteer = true;
    const promise = driver.steer('x', { clientId: id() }); native.item();
    expect(driver.steerState(id())).toMatchObject({ kind: 'observed', acceptance: 'pending' });
    expect(driver.acknowledgeSteer(id())).toBe(false);
    native.frame({ id: native.held[0].id, result: { turnId: 'turn-one' } }); await promise;
    expect(driver.steerState(id())).toMatchObject({ kind: 'observed', acceptance: 'accepted' });
  });
  it.each(['completed', 'interrupted', 'failed'])('ends each unseen accepted steer only after %s drains', async status => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() }); await driver.steer('y', { clientId: id(2) });
    native.end(status); expect(driver.steerState(id())).toMatchObject({ kind: 'accepted' });
    queueMicrotask(() => native.item(id(2), 'buffered-two'));
    await tick(); expect(driver.steerState(id())).toMatchObject({ kind: 'turn_ended_unobserved', turnStatus: status, final: true });
    expect(driver.steerState(id(2))).toMatchObject({ kind: 'observed', nativeItemId: 'buffered-two' });
  });
  it('finishes an acceptance reply arriving after native end and drain', async () => {
    const { driver, native } = await setup(); native.holdSteer = true; const p = driver.steer('x', { clientId: id() });
    native.end(); await tick(); native.frame({ id: native.held[0].id, result: { turnId: 'turn-one' } }); await p;
    expect(driver.steerState(id())).toMatchObject({ kind: 'turn_ended_unobserved', final: true });
  });
  it('does not acknowledge a correlation uncertainty while its native reply is still pending', async () => {
    const { driver, native } = await setup(); native.holdSteer = true;
    const p = driver.steer('x', { clientId: id() }); native.item(null);
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown', acceptance: 'pending' });
    expect(driver.acknowledgeSteer(id())).toBe(false);
    native.frame({ id: native.held[0].id, result: { turnId: 'turn-one' } }); await p;
    expect(driver.acknowledgeSteer(id())).toBe(true);
  });
  it('keeps unobserved FINAL and reports a late item separately, even while a new turn runs', async () => {
    const { driver, native, states } = await setup(); await driver.steer('x', { clientId: id() }); native.end(); await tick();
    native.item(); native.item(id(), 'native-one', 'thread-one', 'turn-one', 'item/completed');
    expect(states.filter(s => s.kind === 'late_item_after_final')).toHaveLength(1);
    expect(driver.steerState(id())).toMatchObject({ kind: 'turn_ended_unobserved' });
    expect(states.filter(s => s.kind === 'observed')).toHaveLength(0);
    expect(states.at(-1)).toMatchObject({ kind: 'late_item_after_final', steerId: id(), nativeItemId: 'native-one' });
  });
  it.each([null, undefined, 'unknown', id(99)])('uses unknown for missing/unmatched native clientId %s', async client => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() });
    native.notify('item/started', { threadId: 'thread-one', turnId: 'turn-one', item: { type: 'userMessage', id: 'native-one', clientId: client } }); native.end(); await tick();
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown', reason: 'missing_correlation' });
  });
  it('ignores foreign thread/turn and replay-shaped input without resolving the current steer', async () => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() });
    native.item(id(), 'foreign', 'foreign-thread'); native.item(id(), 'old', 'thread-one', 'old-turn');
    native.notify('history/userMessage', { threadId: 'thread-one', turnId: 'turn-one', item: { type: 'userMessage', id: 'replayed', clientId: id() } });
    expect(driver.steerState(id())).toMatchObject({ kind: 'accepted' });
  });
  it('conflicting native item IDs cannot remain a precise observed claim', async () => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() }); native.item(); native.item(id(), 'duplicate-native');
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown', reason: 'conflicting_item_ids' });
  });
  it('a later stream gap cannot erase a previously conflicting correlation', async () => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() });
    native.item(); native.item(id(), 'duplicate-native'); native.frame('{broken'); native.item();
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown', reason: 'conflicting_item_ids' });
  });
  it.each(['status', 'id', 'threadId'])('a malformed native end without %s remains uncertain', async field => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() });
    const end: any = { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } };
    if (field === 'threadId') delete end.threadId; else delete end.turn[field];
    native.notify('turn/completed', end); await tick();
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown' });
  });
  it('keeps an already observed item when its native reply is lost', async () => {
    const { driver, native } = await setup(); native.holdSteer = true;
    const p = driver.steer('x', { clientId: id() }); native.item();
    native.frame({ id: native.held[0].id, error: { code: -32000, message: 'SECRET_TOKEN' } });
    expect((await p).outcome).toBe('unknown');
    expect(driver.steerState(id())).toMatchObject({ kind: 'observed', acceptance: 'unknown' });
  });
  it('a malformed stream gap prevents a final absence claim', async () => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() }); native.frame('{broken'); native.end(); await tick();
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown', reason: 'transport_or_protocol_gap' });
  });
  it.each(['threadId', 'turnId', 'itemId'])('missing %s cannot yield a precise absence claim', async field => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() });
    const p: any = { threadId: 'thread-one', turnId: 'turn-one', item: { type: 'userMessage', id: 'native-one', clientId: id() } };
    if (field === 'itemId') delete p.item.id; else delete p[field];
    native.notify('item/started', p); native.end(); await tick();
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown' });
  });
  it('late secret-shaped native errors remain private after a reply timeout', async () => {
    const { driver, native, updates } = await setup(); vi.useFakeTimers(); native.holdSteer = true;
    const p = driver.steer('x', { clientId: id() }); await vi.advanceTimersByTimeAsync(30_001); await p;
    native.frame({ id: native.held[0].id, error: { code: -32000, message: 'SECRET_TOKEN', data: { path: '/private/path' } } });
    expect(JSON.stringify(updates)).not.toMatch(/SECRET_TOKEN|private\/path/);
  });
  it('a transport death surfaces final uncertainty with no raw child error and no resend', async () => {
    const { driver, native, states } = await setup(); native.holdSteer = true;
    const p = driver.steer('x', { clientId: id() }); native.handlers.onExit(1, null);
    expect((await p).outcome).toBe('unknown'); expect(states.at(-1)).toMatchObject({ kind: 'unknown', reason: 'session_ended' });
    expect(driver.steerState(id())).toEqual({ kind: 'not_known' }); expect(native.writes).toHaveLength(1);
  });
  it('refuses duplicate IDs locally, including after acknowledgement', async () => {
    const { driver, native } = await setup(); await driver.steer('x', { clientId: id() }); native.item();
    expect(driver.acknowledgeSteer(id())).toBe(true);
    expect(await driver.steer('x', { clientId: id() })).toMatchObject({ reason: 'duplicate_steer_id' }); expect(native.writes).toHaveLength(1);
  });
  it('refuses at 128 retained records without loss; explicit final acknowledgement frees space', async () => {
    const { driver, native } = await setup(); for (let n = 1; n <= 128; n++) await driver.steer('x', { clientId: id(n) });
    expect(await driver.steer('x', { clientId: id(129) })).toMatchObject({ reason: 'capacity_reached' });
    expect(driver.acknowledgeSteer(id())).toBe(false); expect(driver.steeringState.retainedRecords).toBe(128);
    native.item(); expect(driver.acknowledgeSteer(id())).toBe(true);
    expect((await driver.steer('x', { clientId: id(129) })).outcome).toBe('accepted');
    expect(native.writes).toHaveLength(129); expect(driver.steerState(id(2))).toMatchObject({ kind: 'accepted' });
  });
  it.each(['error', 'partial', 'malformed'])('keeps %s ambiguous and never exposes native secrets or retries', async mode => {
    const { driver, native, states } = await setup();
    if (mode === 'error') native.steerError = { code: -32000, message: 'SECRET_TOKEN', data: { path: '/private/path' } };
    if (mode === 'partial') native.partialWrite = true;
    if (mode === 'malformed') native.steerReply = { turnId: 'SECRET_TOKEN', extra: '/private/path' };
    const reply = await driver.steer('PRIVATE INPUT', { clientId: id() });
    expect(reply.outcome).toBe('unknown'); expect(JSON.stringify(reply)).not.toMatch(/SECRET_TOKEN|private\/path|PRIVATE INPUT/);
    expect(driver.steerState(id())).toMatchObject({ kind: 'unknown' }); expect(native.writes).toHaveLength(1);
    expect(JSON.stringify(states)).not.toMatch(/SECRET_TOKEN|private\/path|PRIVATE INPUT/);
  });
  it('bounds replies at 30s, releases pending RPC, and never retries a late reply', async () => {
    const { driver, native } = await setup(); vi.useFakeTimers(); native.holdSteer = true;
    const p = driver.steer('x', { clientId: id() }); await vi.advanceTimersByTimeAsync(30_001);
    expect(await p).toMatchObject({ outcome: 'unknown', reason: 'reply_timeout' });
    native.frame({ id: native.held[0].id, result: { turnId: 'turn-one' } });
    expect(native.writes).toHaveLength(1); expect(driver.steerState(id())).toMatchObject({ kind: 'unknown' });
  });
  it('callback loss leaves state retrievable and session shutdown surfaces uncertainty before releasing records', async () => {
    const problems: string[] = []; const { driver, states } = await setup('0.167.0', { onSteerUpdate: () => { throw new Error('SECRET'); }, onProtocolError: p => problems.push(p) });
    await driver.steer('x', { clientId: id() }); expect(driver.steerState(id())).toMatchObject({ kind: 'accepted' });
    driver.kill(); expect(states.at(-1)).toMatchObject({ kind: 'unknown', reason: 'session_ended' });
    expect(driver.steerState(id())).toEqual({ kind: 'not_known' }); expect(driver.steeringState.retainedRecords).toBe(0);
    expect(driver.steeringState.activeTurnId).toBeNull();
    expect(problems.join(' ')).not.toContain('SECRET');
    const next = await setup(); expect(next.driver.steerState(id())).toEqual({ kind: 'not_known' });
  });
  it('finishes cleanup before an active-turn notice callback can start a new turn with its own approval', async () => {
    let h!: Awaited<ReturnType<typeof setup>>, armed = false, answer!: (value: any) => void;
    h = await setup('0.167.0', {
      onRequestPermission: () => new Promise(r => { answer = r; }),
      onUpdate: u => {
        if (!armed || (u._meta as any)?.[META_ACTIVE_TURN]?.activeTurnId !== null) return;
        armed = false; h.driver.prompt('next');
        h.native.notify('turn/started', { threadId: 'thread-one', turn: { id: 'turn-two' } });
        h.native.frame({ id: 995, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-one', turnId: 'turn-two', itemId: 'next-cmd', command: 'CONTROLLED', availableDecisions: ['accept', 'decline'] } });
      },
    });
    armed = true; h.native.end(); await tick(); answer({ outcome: 'cancelled' }); await tick();
    expect(h.native.sent.some(f => f.id === 995)).toBe(true);
  });
  it('a throwing diagnostic listener cannot mask acceptance or prevent provider shutdown', async () => {
    const { driver, native } = await setup('0.167.0', {
      onSteerUpdate: () => { throw new Error('HOST_LISTENER_ERROR'); },
      onProtocolError: () => { throw new Error('HOST_DIAGNOSTIC_ERROR'); },
    });
    expect((await driver.steer('x', { clientId: id() })).outcome).toBe('accepted');
    expect(() => driver.kill()).not.toThrow(); expect(native.closes).toBe(1);
    expect(driver.steeringState.retainedRecords).toBe(0);
  });
  it('a lost active-turn callback cannot prevent native turn completion', async () => {
    const ended: unknown[] = [];
    const { driver, native } = await setup('0.167.0', {
      onUpdate: u => { if ((u._meta as any)?.[META_ACTIVE_TURN]) throw new Error('HOST_UPDATE_ERROR'); },
      onProtocolError: () => { throw new Error('HOST_DIAGNOSTIC_ERROR'); },
      onTurnEnd: value => ended.push(value),
    });
    native.end(); expect(ended).toHaveLength(1); driver.kill();
    expect(driver.steeringState.activeTurnId).toBeNull();
  });
  it('keeps potentially consumed images until session cleanup and validates every block before allocation', async () => {
    const { driver, native } = await setup(); native.steerReply = {};
    await driver.steer([{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], { clientId: id() });
    const image = native.writes[0].params.input[0].path;
    expect(readFileSync(image, 'utf8')).toBe('hello'); expect(existsSync(image)).toBe(true);
    driver.kill(); expect(existsSync(image)).toBe(false);
  });
});

describe('namespaced ACP steering', () => {
  it('uses the owned session, exposes metadata/state and explicit acknowledgement; ordinary prompt stays refused', async () => {
    const sent: any[] = [], natives: Native[] = [], ds: CodexDriver[] = [];
    const peer = new JsonRpcPeer({ send: f => sent.push(f) }); let seq = 0;
    const agent = new AcpAgent(peer, { newSessionId: () => 'owned', driverCapabilities: CODEX_DRIVER_CAPABILITIES,
      driverFactory: (options, events) => { const d = new CodexDriver(options, events, (_o, h) => { const n = new Native(h); natives.push(n); return n; }); drivers.push(d); ds.push(d); return d; } });
    const call = async (method: string, params: unknown) => { const n = ++seq; await peer.receive({ jsonrpc: '2.0', id: n, method, params }); return sent.find(f => f.id === n); };
    await call('session/new', { cwd: process.cwd() }); await ds[0].ready;
    const prompt = call('session/prompt', { sessionId: 'owned', prompt: [{ type: 'text', text: 'initial' }] }); await tick();
    const params = { sessionId: 'owned', clientId: id(), expectedTurnId: 'turn-one', prompt: [{ type: 'text', text: 'x' }] };
    expect((await call('_particle.academy/session/steer', params)).result.outcome).toBe('accepted');
    expect((await call('session/prompt', { sessionId: 'owned', prompt: [{ type: 'text', text: 'ordinary' }] })).error).toBeDefined();
    expect((await call('_particle.academy/session/steer', { ...params, threadId: 'foreign' })).error).toBeDefined();
    expect((await call('_particle.academy/session/steer', { ...params, sessionId: 'foreign' })).error).toBeDefined();
    natives[0].item();
    expect((await call('_particle.academy/session/steer_state', { sessionId: 'owned', clientId: id() })).result.kind).toBe('observed');
    expect(sent.some(f => f.method === 'session/update' && f.params.update._meta?.[META_STEER]?.kind === 'observed')).toBe(true);
    expect((await call('_particle.academy/session/acknowledge_steer', { sessionId: 'owned', clientId: id() })).result).toEqual({ acknowledged: true });
    expect((await call('_particle.academy/session/steer_state', { sessionId: 'owned', clientId: id() })).result).toEqual({ kind: 'not_known' });
    natives[0].frame({ id: 994, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-one', turnId: 'turn-one', itemId: 'cmd', command: 'CONTROLLED', availableDecisions: ['accept', 'decline'] } });
    const permission = sent.find(f => f.method === 'session/request_permission'); expect(permission).toBeDefined();
    expect((await call('_particle.academy/session/steer', { ...params, clientId: id(2) })).result.outcome).toBe('accepted');
    expect(natives[0].sent.some(f => f.id === 994)).toBe(false);
    natives[0].end('interrupted'); await prompt; await tick();
    expect((await call('_particle.academy/session/steer_state', { sessionId: 'owned', clientId: id(2) })).result).toMatchObject({ kind: 'turn_ended_unobserved', turnStatus: 'interrupted', final: true });
    await peer.receive({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'codex-accept' } } });
    expect(natives[0].sent.some(f => f.id === 994)).toBe(false); agent.closeAll();
  });
});
