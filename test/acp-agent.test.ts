import { describe, expect, it, vi } from 'vitest';
import { AcpAgent, PROTOCOL_VERSION, type AcpAgentOptions, type AgentDriver, type DriverEvents } from '../src/acp/agent.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';
import { PLAN_ENTRY_CONTENT_MAX, PLAN_META_MAX_BYTES } from '../src/plan.js';
import type { TurnOutcome } from '../src/claude/driver.js';
import { sessionNotificationProblems, sessionUpdateProblems } from './acp-schema.js';

/**
 * A driver that records what it was asked and lets a test decide the outcome.
 *
 * Standing in for a real CLI here is the point, not a shortcut: the session
 * bookkeeping -- several sessions at once, one turn each, what happens when a
 * process dies mid-turn -- is where this surface can be wrong, and none of it
 * is reachable through a real agent without making every test a live one.
 */
class FakeDriver implements AgentDriver {
  started = false;
  killed = false;
  readonly prompts: string[] = [];
  cliSessionId: string | null = 'cli-session';
  withheldCredentials: readonly string[] = [];

  constructor(
    readonly options: { cwd: string; resumeSessionId?: string },
    readonly events: DriverEvents,
  ) {}

  start(): void {
    this.started = true;
  }
  prompt(text: string): void {
    this.prompts.push(text);
  }
  endInput(): void {}
  kill(): void {
    this.killed = true;
  }

  /** Finish the in-flight turn as the real driver would. */
  finish(outcome: Partial<TurnOutcome> = {}): void {
    this.events.onTurnEnd?.({
      stopReason: 'end_turn',
      isError: false,
      raw: 'end_turn',
      ...outcome,
    });
  }

  emit(update: Record<string, unknown> & { sessionUpdate: string }): void {
    this.events.onUpdate?.(update);
  }

  die(code = 1): void {
    this.events.onExit?.(code, null);
  }
}

function harness(
  probeSession?: AcpAgentOptions['probeSession'],
  driverCapabilities?: AcpAgentOptions['driverCapabilities'],
) {
  const sent: Record<string, unknown>[] = [];
  const drivers: FakeDriver[] = [];
  const peer = new JsonRpcPeer({ send: (m) => sent.push(m as Record<string, unknown>) });
  let n = 0;
  const agent = new AcpAgent(peer, {
    driverFactory: (options, events) => {
      const driver = new FakeDriver(options, events);
      drivers.push(driver);
      return driver;
    },
    newSessionId: () => `sess_${++n}`,
    ...(probeSession === undefined ? {} : { probeSession }),
    ...(driverCapabilities === undefined ? {} : { driverCapabilities }),
  });
  return { agent, peer, sent, drivers };
}

/** Drive one request through the peer and return its reply. */
async function call(
  h: ReturnType<typeof harness>,
  method: string,
  params?: unknown,
  id = 1,
): Promise<Record<string, unknown>> {
  const before = h.sent.length;
  await h.peer.receive({ jsonrpc: '2.0', id, method, params });
  return h.sent.slice(before).find((m) => m.id === id) ?? {};
}

describe('initialize', () => {
  it('reports declared driver capabilities only in _meta', async () => {
    const declared = { permissionRequests: false, transcriptReplay: false } as const;
    const h = harness(undefined, declared);
    const result = (await call(h, 'initialize', {})).result as Record<string, unknown>;
    expect((result._meta as Record<string, unknown>)?.['particle.academy/driver_capabilities']).toEqual(declared);
    expect(result.agentCapabilities).not.toHaveProperty('permissionRequests');
    expect(result.agentCapabilities).not.toHaveProperty('transcriptReplay');
  });

  it('omits driver capabilities when the embedder did not declare them', async () => {
    const h = harness();
    const result = (await call(h, 'initialize', {})).result as Record<string, unknown>;
    expect(result).not.toHaveProperty('_meta');
  });

  it('answers with the version it will speak, not the one it was asked', async () => {
    // A client may ask for anything; echoing a number we do not implement back
    // at it would be a claim rather than a negotiation.
    const h = harness();
    const reply = await call(h, 'initialize', { protocolVersion: 99 });
    expect((reply.result as Record<string, unknown>).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('reports NO auth methods, because there is genuinely nothing to authenticate', async () => {
    // The credential belongs to the CLI and never travels in this protocol.
    // Empty is the honest answer here, not a placeholder.
    const h = harness();
    const result = (await call(h, 'initialize', {})).result as Record<string, unknown>;
    expect(result.authMethods).toEqual([]);
  });

  it('reports loadSession true, which session/load actually implements', async () => {
    const h = harness();
    const result = (await call(h, 'initialize', {})).result as Record<string, unknown>;
    const caps = result.agentCapabilities as Record<string, unknown>;
    expect(caps.loadSession).toBe(true);
  });

  it('reports unsupported prompt kinds as FALSE rather than omitting them', async () => {
    // A client needs to know we will refuse an image, not merely fail to
    // mention it. Absent reads as "unknown"; false reads as "no".
    const h = harness();
    const result = (await call(h, 'initialize', {})).result as Record<string, unknown>;
    const prompt = (result.agentCapabilities as Record<string, Record<string, unknown>>)
      .promptCapabilities;
    expect(prompt).toEqual({ image: false, audio: false, embeddedContext: false });
  });
});

describe('session/new', () => {
  it('opens a session and starts its driver', async () => {
    const h = harness();
    const reply = await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    expect((reply.result as Record<string, unknown>).sessionId).toBe('sess_1');
    expect(h.drivers[0]?.started).toBe(true);
    expect(h.drivers[0]?.options.cwd).toBe('/work');
  });

  it('REFUSES a relative cwd rather than resolving it', async () => {
    // ACP says cwd MUST be absolute, and it is the session's filesystem
    // boundary. Anchoring a relative path to wherever this process happens to
    // run would put the agent somewhere the client never named.
    const h = harness();
    const reply = await call(h, 'session/new', { cwd: 'work', mcpServers: [] });
    expect(reply.error).toMatchObject({ message: expect.stringContaining('absolute') });
    expect(h.drivers).toHaveLength(0);
  });

  it('accepts a Windows absolute path', async () => {
    const h = harness();
    const reply = await call(h, 'session/new', { cwd: 'C:\\work', mcpServers: [] });
    expect(reply.result).toBeDefined();
  });

  it('refuses a missing cwd', async () => {
    const h = harness();
    expect((await call(h, 'session/new', {})).error).toBeDefined();
  });

  it('holds SEVERAL sessions at once, each with its own driver', async () => {
    // The first consumer needs a room of several agents. A server that assumed
    // one session would pass every test above and have to be rebuilt for the
    // second agent.
    const h = harness();
    await call(h, 'session/new', { cwd: '/a', mcpServers: [] }, 1);
    await call(h, 'session/new', { cwd: '/b', mcpServers: [] }, 2);
    expect(h.agent.sessionIds).toEqual(['sess_1', 'sess_2']);
    expect(h.drivers.map((d) => d.options.cwd)).toEqual(['/a', '/b']);
  });
});

describe('session/prompt', () => {
  async function opened() {
    const h = harness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    return h;
  }

  it('sends the prompt text and resolves with the stop reason', async () => {
    const h = await opened();
    const promise = h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hello' }] },
    });

    expect(h.drivers[0]?.prompts).toEqual(['hello']);
    h.drivers[0]?.finish();
    await promise;

    const reply = h.sent.find((m) => m.id === 2);
    expect(reply?.result).toEqual({ stopReason: 'end_turn' });
  });

  it('does not answer a pending prompt with the end of a turn the CLI started itself (G-313)', async () => {
    const h = await opened();
    const promise = h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hello' }] },
    });
    h.drivers[0]?.finish({ stopReason: 'max_tokens', raw: 'max_tokens', unsolicited: true, unsolicitedTurnId: 'self-1' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.sent.find((m) => m.id === 2)).toBeUndefined();
    h.drivers[0]?.finish();
    await promise;
    expect(h.sent.find((m) => m.id === 2)?.result).toEqual({ stopReason: 'end_turn' });
  });

  it('streams session/update notifications for the session', async () => {
    const h = await opened();
    h.drivers[0]?.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });

    const note = h.sent.find((m) => m.method === 'session/update');
    expect(note?.params).toEqual({
      sessionId: 'sess_1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    });
  });

  it('ERRORS rather than inventing a stop reason when a turn does not complete', async () => {
    // ACP's five reasons all describe a turn that FINISHED. None describes a
    // crash, so `end_turn` would claim a clean finish and `refusal` would claim
    // a decision the agent never made.
    const h = await opened();
    const promise = h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    h.drivers[0]?.finish({ stopReason: null, isError: true, raw: 'boom' });
    await promise;

    const reply = h.sent.find((m) => m.id === 2);
    expect(reply?.result).toBeUndefined();
    expect(reply?.error).toMatchObject({ message: expect.stringContaining('did not complete') });
  });

  it('says WHY a failed turn failed, structurally, in the error data (tynn #791)', async () => {
    const h = await opened();
    const promise = h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    h.drivers[0]?.finish({
      stopReason: null, isError: true, raw: 'error_during_execution',
      failure: { reason: 'rate_limit', kind: 'rate_limit', resetsAtMs: 1_792_302_600_000 },
    });
    await promise;

    const reply = h.sent.find((m) => m.id === 2);
    expect(reply?.error).toMatchObject({
      data: { 'particle.academy/turn_failure': { reason: 'rate_limit', kind: 'rate_limit', resetsAtMs: 1_792_302_600_000 } },
    });
  });

  it('sends no failure data when the provider gave no reason (the control)', async () => {
    const h = await opened();
    const promise = h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    h.drivers[0]?.finish({ stopReason: null, isError: true, raw: 'boom' });
    await promise;

    expect((h.sent.find((m) => m.id === 2)?.error as Record<string, unknown> | undefined)?.data).toBeUndefined();
  });

  it('settles an in-flight turn when the agent process DIES', async () => {
    // Otherwise session/prompt never returns and the client waits forever on an
    // agent that no longer exists.
    const h = await opened();
    const promise = h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    h.drivers[0]?.die(137);
    await promise;

    expect(h.sent.find((m) => m.id === 2)?.error).toMatchObject({
      message: expect.stringContaining('137'),
    });
  });

  it('refuses a second concurrent turn on one session', async () => {
    // Two interleaved turns put their updates on one stream with nothing to
    // tell them apart.
    const h = await opened();
    void h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'one' }] },
    });
    const second = await call(
      h,
      'session/prompt',
      { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'two' }] },
      3,
    );
    expect(second.error).toMatchObject({ message: expect.stringContaining('in flight') });
  });

  it('allows concurrent turns in DIFFERENT sessions', async () => {
    // The room case: two agents thinking at the same time is normal.
    const h = await opened();
    await call(h, 'session/new', { cwd: '/b', mcpServers: [] }, 9);

    void h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'a' }] },
    });
    void h.peer.receive({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'sess_2', prompt: [{ type: 'text', text: 'b' }] },
    });

    expect(h.drivers[0]?.prompts).toEqual(['a']);
    expect(h.drivers[1]?.prompts).toEqual(['b']);
  });

  it('refuses an unknown session', async () => {
    const h = await opened();
    const reply = await call(
      h,
      'session/prompt',
      { sessionId: 'nope', prompt: [{ type: 'text', text: 'x' }] },
      2,
    );
    expect(reply.error).toMatchObject({ message: expect.stringContaining('no such session') });
  });

  it('refuses an empty prompt rather than sending a blank turn', async () => {
    // An agent answering a blank turn says something unrelated, which reads as
    // a model problem rather than a protocol one.
    const h = await opened();
    expect((await call(h, 'session/prompt', { sessionId: 'sess_1', prompt: [] }, 2)).error)
      .toBeDefined();
  });

  it('refuses a prompt of blocks it cannot render', async () => {
    const h = await opened();
    const reply = await call(
      h,
      'session/prompt',
      { sessionId: 'sess_1', prompt: [{ type: 'image', data: 'x' }] },
      2,
    );
    expect(reply.error).toBeDefined();
  });

  it('joins several text blocks', async () => {
    const h = await opened();
    void h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId: 'sess_1',
        prompt: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    });
    expect(h.drivers[0]?.prompts).toEqual(['first\nsecond']);
  });
});

describe('session/cancel', () => {
  it('RESOLVES the turn as cancelled rather than erroring', async () => {
    // `cancelled` is one of ACP's five stop reasons. The client asked for this
    // outcome, so it is not a failure and must not be reported as one.
    const h = harness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    const promise = h.peer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] },
    });

    await h.peer.receive({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_1' } });
    await promise;

    expect(h.sent.find((m) => m.id === 2)?.result).toEqual({ stopReason: 'cancelled' });
    expect(h.drivers[0]?.killed).toBe(true);
  });

  it('is silent about an unknown session, because a notification has no reply', async () => {
    const h = harness();
    await h.peer.receive({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'x' } });
    expect(h.sent).toEqual([]);
  });

  it('leaves an IDLE session alone: with no turn to cancel there is nothing to stop', async () => {
    const h = harness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    await h.peer.receive({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_1' } });
    expect(h.drivers[0]?.killed).toBe(false);

    const promise = h.peer.receive({
      jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    h.drivers[0]?.finish();
    await promise;
    expect(h.sent.find((m) => m.id === 2)?.result).toEqual({ stopReason: 'end_turn' });
  });
});

/**
 * A driver that can interrupt a turn (issue #16): `cancel()` asks the agent to stop the turn, and the turn ends --
 * later, through onTurnEnd -- the way the real Codex driver's does once `turn/completed` reports `interrupted`.
 */
class CancellableFakeDriver extends FakeDriver {
  cancels = 0;
  kills = 0;
  cancelFailure: Error | null = null;

  async cancel(): Promise<void> {
    this.cancels += 1;
    if (this.cancelFailure !== null) throw this.cancelFailure;
  }

  override kill(): void {
    this.kills += 1;
    super.kill();
  }
}

function cancellableHarness() {
  const sent: Record<string, unknown>[] = [];
  const drivers: CancellableFakeDriver[] = [];
  const peer = new JsonRpcPeer({ send: (m) => sent.push(m as Record<string, unknown>) });
  let n = 0;
  const agent = new AcpAgent(peer, {
    driverFactory: (options, events) => {
      const driver = new CancellableFakeDriver(options, events);
      drivers.push(driver);
      return driver;
    },
    newSessionId: () => `sess_${++n}`,
  });
  return { agent, peer, sent, drivers };
}

describe('session/cancel with a driver that can cancel a turn', () => {
  async function promptIn(h: ReturnType<typeof cancellableHarness>, id: number, text: string) {
    return h.peer.receive({
      jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: 'sess_1', prompt: [{ type: 'text', text }] },
    });
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('CANCELS the turn through the driver and keeps the session alive for the next prompt', async () => {
    const h = cancellableHarness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    const first = promptIn(h, 2, 'long task');

    await h.peer.receive({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_1' } });
    await tick();
    const driver = h.drivers[0]!;
    expect(driver.cancels).toBe(1);
    expect(driver.kills).toBe(0);

    // The turn ends when the AGENT says it ended.
    driver.finish({ stopReason: 'cancelled', raw: 'interrupted' });
    await first;
    expect(h.sent.find((m) => m.id === 2)?.result).toEqual({ stopReason: 'cancelled' });

    const second = promptIn(h, 3, 'next');
    expect(driver.prompts).toEqual(['long task', 'next']);
    driver.finish();
    await second;
    expect(h.sent.find((m) => m.id === 3)?.result).toEqual({ stopReason: 'end_turn' });
    expect(driver.kills).toBe(0);
    expect(h.agent.sessionIds).toEqual(['sess_1']);
  });

  it('answers cancelled even when the turn finished in the race with the interrupt, as ACP requires', async () => {
    const h = cancellableHarness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    const first = promptIn(h, 2, 'task');
    await h.peer.receive({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_1' } });
    h.drivers[0]!.finish({ stopReason: 'end_turn' });
    await first;
    expect(h.sent.find((m) => m.id === 2)?.result).toEqual({ stopReason: 'cancelled' });
  });

  it('falls back to stopping the agent when the interrupt fails, so Stop always stops', async () => {
    const h = cancellableHarness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    h.drivers[0]!.cancelFailure = new Error('turn/interrupt refused');
    const first = promptIn(h, 2, 'task');
    await h.peer.receive({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_1' } });
    await tick();
    await first;
    expect(h.sent.find((m) => m.id === 2)?.result).toEqual({ stopReason: 'cancelled' });
    expect(h.drivers[0]!.kills).toBe(1);
  });

  it('does not call the driver with no turn in flight', async () => {
    const h = cancellableHarness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    await h.peer.receive({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_1' } });
    await tick();
    expect(h.drivers[0]!.cancels).toBe(0);
    expect(h.drivers[0]!.kills).toBe(0);
  });

  it('control: closing the server still kills a driver that can cancel', async () => {
    const h = cancellableHarness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    h.agent.closeAll();
    expect(h.drivers[0]!.kills).toBe(1);
    expect(h.drivers[0]!.cancels).toBe(0);
  });
});

describe('session/load', () => {
  it('resumes by passing the id to the driver', async () => {
    const h = harness();
    const reply = await call(h, 'session/load', { sessionId: 'old-1', cwd: '/work', mcpServers: [] });
    expect(reply.result).toEqual({});
    expect(h.drivers[0]?.options.resumeSessionId).toBe('old-1');
    expect(h.agent.sessionIds).toEqual(['old-1']);
  });

  it('refuses to load a session that is already open', async () => {
    // Two processes writing updates for one session id makes the second look
    // like the first stuttering.
    const h = harness();
    await call(h, 'session/load', { sessionId: 'old-1', cwd: '/work', mcpServers: [] }, 1);
    const again = await call(h, 'session/load', { sessionId: 'old-1', cwd: '/work', mcpServers: [] }, 2);
    expect(again.error).toMatchObject({ message: expect.stringContaining('already open') });
    expect(h.drivers).toHaveLength(1);
  });

  it('requires a sessionId', async () => {
    const h = harness();
    expect((await call(h, 'session/load', { cwd: '/work', mcpServers: [] })).error).toBeDefined();
  });

  it('REVIVES a session whose agent exited, which is what resume is for', async () => {
    // This was refused as "already open", and that described the sessions map
    // rather than reality: an exited session is never removed from it, only
    // flagged. So the one state anyone resumes from -- a crashed or killed
    // agent, or one lost to a restart -- was the one state rejected.
    const h = harness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] }, 1);
    const cliId = h.drivers[0]?.cliSessionId;
    expect(cliId).toBe('cli-session');

    h.drivers[0]?.events.onExit?.(1, null);

    const revived = await call(
      h,
      'session/load',
      { sessionId: cliId, cwd: '/work', mcpServers: [] },
      2,
    );

    expect(revived.result).toEqual({});
    // One new agent, and it is resuming -- not a second agent on a fresh
    // conversation, which is the failure that looks like success.
    expect(h.drivers).toHaveLength(2);
    expect(h.drivers[1]?.options.resumeSessionId).toBe(cliId);
  });

  it('resumes the SAME conversation twice, which a restart loop requires', async () => {
    // The case the exited-versus-live distinction actually exists for, and the
    // one `REVIVES` above does not reach: a load keys the session by the CLI id,
    // so the SECOND load of that id finds its own earlier entry in the map.
    // Refusing it as "already open" would mean a conversation could survive one
    // restart and never two -- and a machine that wedges 21 agents at a time
    // restarts more than once.
    const h = harness();
    const cliId = 'cli-session';

    await call(h, 'session/load', { sessionId: cliId, cwd: '/work', mcpServers: [] }, 1);
    h.drivers[0]?.events.onExit?.(1, null);

    const second = await call(
      h,
      'session/load',
      { sessionId: cliId, cwd: '/work', mcpServers: [] },
      2,
    );

    expect(second.result).toEqual({});
    expect(h.drivers).toHaveLength(2);
    expect(h.drivers[1]?.options.resumeSessionId).toBe(cliId);
  });

  it('still refuses a session whose agent is STILL RUNNING', async () => {
    // The narrower refusal must not have become no refusal: two processes
    // writing updates for one session id makes the second look like the first
    // stuttering.
    const h = harness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] }, 1);
    const cliId = h.drivers[0]?.cliSessionId;

    const again = await call(
      h,
      'session/load',
      { sessionId: cliId, cwd: '/work', mcpServers: [] },
      2,
    );

    expect(again.error).toMatchObject({
      message: expect.stringContaining('still running'),
    });
    expect(h.drivers).toHaveLength(1);
  });

  it('REFUSES an id this server minted, which --resume provably cannot take', async () => {
    // The hole this closes: session/new hands back an id of OUR making, the CLI
    // resumes only by its own UUID, and passing the former to --resume cannot
    // work. The CLI does error on it rather than silently starting fresh --
    // verified against claude 2.1.292, both for a non-UUID and for a well-formed
    // UUID that does not exist -- but that error arrives when the first PROMPT
    // runs, long after session/load has returned success and the client has
    // concluded it holds a resumed session.
    const h = harness();
    const reply = await call(h, 'session/load', {
      sessionId: 'sess_1_1791400000000',
      cwd: '/work',
      mcpServers: [],
    });

    expect(reply.error).toBeDefined();
    // The message must say what to pass INSTEAD. The CLI's own error cannot,
    // because the CLI has never heard of ACP.
    expect(reply.error).toMatchObject({
      message: expect.stringContaining('particle.academy/cli_session_id'),
    });
    // And nothing is spawned, so no process is left writing updates for a
    // session the client does not actually have.
    expect(h.drivers).toHaveLength(0);
  });

  it('still accepts a session TITLE, which the CLI does take alongside a UUID', async () => {
    // The refusal above is deliberately narrow. A broader "does not look like a
    // UUID" test would reject a title, and the CLI accepts those.
    const h = harness();
    const reply = await call(h, 'session/load', {
      sessionId: 'my-saved-conversation',
      cwd: '/work',
      mcpServers: [],
    });

    expect(reply.result).toEqual({});
    expect(h.drivers[0]?.options.resumeSessionId).toBe('my-saved-conversation');
  });

  it('closes the loop: the id handed out by session/new is refused by session/load', async () => {
    // The whole defect in one assertion. A client doing the obvious thing --
    // store what session/new returned, pass it back to session/load -- must now
    // be TOLD, rather than discovering it when its first prompt dies.
    //
    // This harness injects `newSessionId: () => 'sess_N'`, which the default
    // mint PATTERN does not match. That makes this the embedder case: it passes
    // only because the agent records the ids it actually handed out, not because
    // the id looks like ours.
    const h = harness();
    const created = await call(h, 'session/new', { cwd: '/work', mcpServers: [] }, 1);
    const mintedId = (created.result as { sessionId: string }).sessionId;
    expect(mintedId).not.toMatch(/^sess_\d+_\d+$/);

    // The agent process dies -- a crash, a kill, a Genie restart. This is the
    // state anyone actually tries to resume from.
    h.drivers[0]?.events.onExit?.(1, null);

    const resumed = await call(
      h,
      'session/load',
      { sessionId: mintedId, cwd: '/work', mcpServers: [] },
      2,
    );

    expect(resumed.error).toMatchObject({
      message: expect.stringContaining('particle.academy/cli_session_id'),
    });
  });

  it('does NOT pass resumeSessionId for a new session', async () => {
    // A wrong resume flag does not error -- it starts a fresh conversation
    // while the caller believes it continued one.
    const h = harness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    expect(h.drivers[0]?.options.resumeSessionId).toBeUndefined();
  });
});

describe('closeAll', () => {
  it('kills every session, so no agent is left running with nobody listening', async () => {
    const h = harness();
    await call(h, 'session/new', { cwd: '/a', mcpServers: [] }, 1);
    await call(h, 'session/new', { cwd: '/b', mcpServers: [] }, 2);
    h.agent.closeAll();
    expect(h.drivers.map((d) => d.killed)).toEqual([true, true]);
    expect(h.agent.sessionIds).toEqual([]);
  });
});

describe('unknown methods still get an answer', () => {
  it('answers a method this agent does not implement', async () => {
    // Inherited from the peer, and asserted here because the agent registering
    // handlers must not accidentally swallow the behaviour: silence parks the
    // client forever.
    const h = harness();
    const reply = await call(h, 'session/set_mode', { sessionId: 'x' }, 5);
    expect(reply.error).toMatchObject({ code: -32601 });
  });

  it('answers session/set_mode specifically, which a client is likely to try', async () => {
    // ACP lists session/set_mode as optional. We do not implement it yet, and
    // the thing that must be true is that a client asking gets a refusal rather
    // than nothing -- an unimplemented optional method is the most likely place
    // for a silent hang to appear.
    const h = harness();
    await call(h, 'session/new', { cwd: '/w', mcpServers: [] }, 1);
    const reply = await call(h, 'session/set_mode', { sessionId: 'sess_1', modeId: 'plan' }, 2);
    expect(reply.error).toBeDefined();
    expect(reply.result).toBeUndefined();
  });
});

describe('session/load refuses an id that names no conversation', () => {
  // Without the probe this all happened a turn later: the agent started,
  // session/load returned success, and the CLI's "No conversation found with
  // session ID" arrived on the first prompt -- indistinguishable from any
  // other late failure, and after the client had been told it held a session.
  const UUID = '11111111-2222-3333-4444-555555555555';

  it('REFUSES an absent id at load, naming why, and starts no agent', async () => {
    const h = harness(() => ({ existence: 'absent' as const, detail: 'no conversation with that id exists here.' }));
    const reply = await call(h, 'session/load', { sessionId: UUID, cwd: '/work', mcpServers: [] });
    expect(reply.error).toMatchObject({
      message: expect.stringContaining('cannot resume 11111111-2222-3333-4444-555555555555'),
    });
    expect(reply.error).toMatchObject({ message: expect.stringContaining('no conversation with that id exists here.') });
    expect(h.drivers).toHaveLength(0);
  });

  it('PROCEEDS when the probe cannot tell, because a store it cannot read must not refuse a working resume', async () => {
    const h = harness(() => ({ existence: 'indeterminate' as const, detail: 'home relocated' }));
    const reply = await call(h, 'session/load', { sessionId: UUID, cwd: '/work', mcpServers: [] });
    expect(reply.result).toEqual({});
    expect(h.drivers[0]?.options.resumeSessionId).toBe(UUID);
  });

  it('PROCEEDS for a present id', async () => {
    const h = harness(() => ({ existence: 'present' as const, detail: '' }));
    const reply = await call(h, 'session/load', { sessionId: UUID, cwd: '/work', mcpServers: [] });
    expect(reply.result).toEqual({});
    expect(h.drivers).toHaveLength(1);
  });

  it('behaves exactly as before when no probe is supplied', async () => {
    // The probe is optional, so an embedder supplying none keeps the old
    // contract rather than silently losing the ability to resume.
    const h = harness();
    const reply = await call(h, 'session/load', { sessionId: UUID, cwd: '/work', mcpServers: [] });
    expect(reply.result).toEqual({});
    expect(h.drivers).toHaveLength(1);
  });

  it('refuses a MINTED id before it ever consults the probe', async () => {
    // Order matters: the minted-id refusal names the _meta key to use instead,
    // which is more actionable than "no such conversation" -- and a minted id
    // is never in the store anyway, so a probe-first order would replace a
    // precise message with a vague one.
    //
    // `sess_123_456` matches the minted PATTERN without ever having been handed
    // out, which is the branch that survives a restart -- and it keeps this
    // test off the already-open path, which fires first and for a different
    // reason when the session is still live.
    let consulted = 0;
    const h = harness(() => {
      consulted++;
      return { existence: 'absent' as const, detail: 'should not be reached' };
    });
    const reply = await call(h, 'session/load', { sessionId: 'sess_123_456', cwd: '/work', mcpServers: [] });
    expect(reply.error).toMatchObject({ message: expect.stringContaining('minted by this server') });
    expect(consulted).toBe(0);
    expect(h.drivers).toHaveLength(0);
  });
});

/**
 * THE MODEL STATE OVER ACP (tynn, for the owner, 2026-10-21). session/new and session/load carry ACP's (unstable)
 * `models: { availableModels, currentModelId }` from the driver, and `session/set_model` switches a live session.
 * What ACP's model info has no field for rides in `_meta`.
 */
describe('models', () => {
  class ModelDriver extends FakeDriver {
    switched: string[] = [];
    refuse = false;
    failList = false;
    async modelState() {
      if (this.failList) throw new Error('no answer');
      return {
        availableModels: [
          { modelId: 'default', name: 'Default', resolvedModel: 'claude-opus-5-5', isDefault: true },
          { modelId: 'fable', name: 'Fable 5.1', description: 'For your toughest challenges', resolvedModel: 'claude-fable-5-1' },
        ],
        currentModelId: this.switched.at(-1) ?? 'default',
      };
    }
    async setModel(modelId: string) {
      if (this.refuse) throw new Error(`the CLI refused ${modelId}`);
      this.switched.push(modelId);
    }
  }
  function modelHarness(configure: (driver: ModelDriver) => void = () => {}) {
    const sent: Record<string, unknown>[] = [];
    const drivers: ModelDriver[] = [];
    const problems: string[] = [];
    const peer = new JsonRpcPeer({ send: (m) => sent.push(m as Record<string, unknown>) });
    new AcpAgent(peer, {
      driverFactory: (options, events) => {
        const driver = new ModelDriver(options, events);
        configure(driver);
        drivers.push(driver);
        return driver;
      },
      newSessionId: () => 'sess_models',
      onProtocolError: (_id, problem) => problems.push(problem),
    });
    return { peer, sent, drivers, problems } as unknown as ReturnType<typeof harness> & { drivers: ModelDriver[]; problems: string[] };
  }

  it('session/new carries the provider\'s models in ACP\'s shape', async () => {
    const h = modelHarness();
    const reply = await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    expect(reply.result).toEqual({
      sessionId: 'sess_models',
      models: {
        availableModels: [
          { modelId: 'default', name: 'Default', _meta: { 'particle.academy/model_info': { resolvedModel: 'claude-opus-5-5', isDefault: true } } },
          { modelId: 'fable', name: 'Fable 5.1', description: 'For your toughest challenges', _meta: { 'particle.academy/model_info': { resolvedModel: 'claude-fable-5-1' } } },
        ],
        currentModelId: 'default',
      },
    });
  });

  it('session/set_model switches the live session; a refusal is an error the client sees', async () => {
    const h = modelHarness();
    await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    expect((await call(h, 'session/set_model', { sessionId: 'sess_models', modelId: 'fable' }, 2)).result).toEqual({});
    expect(h.drivers[0]!.switched).toEqual(['fable']);

    h.drivers[0]!.refuse = true;
    const refused = await call(h, 'session/set_model', { sessionId: 'sess_models', modelId: 'nope' }, 3);
    expect((refused.error as { message: string }).message).toMatch(/refused nope/);
    const unknown = await call(h, 'session/set_model', { sessionId: 'sess_other', modelId: 'fable' }, 4);
    expect((unknown.error as { message: string }).message).toMatch(/no live session/);
  });

  it('a driver that cannot say leaves models OUT -- never invented -- and the session still opens', async () => {
    const h = modelHarness((driver) => { driver.failList = true; });
    const reply = await call(h, 'session/new', { cwd: '/work', mcpServers: [] });
    expect(reply.result).toEqual({ sessionId: 'sess_models' });
    expect(h.problems.some((p) => p.includes('could not report its models'))).toBe(true);
  });

  it('CONTROL: a driver with no model support answers session/new as before', async () => {
    const h = harness();
    expect((await call(h, 'session/new', { cwd: '/work', mcpServers: [] })).result).toEqual({ sessionId: 'sess_1' });
  });
});

/**
 * G-362 at the seam every driver shares. `plan_update` and `plan_removed` MUST NOT reach a client that did not
 * advertise `clientCapabilities.plan`, and a plan entry MUST carry a priority. Both are enforced here, where every
 * driver's updates leave the agent, so no driver -- shipped, external, or one not written yet -- can send either.
 */
describe('plan updates and the client capability (G-362)', () => {
  const entry = { content: 'step', priority: 'medium', status: 'pending' };
  const itemsUpdate = { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [entry], _meta: { 'particle.academy/plan': { revision: 1 } } } };

  async function session(clientCapabilities: unknown, report?: (problem: string) => void) {
    const sent: Record<string, unknown>[] = [];
    const drivers: FakeDriver[] = [];
    const problems: string[] = [];
    const peer = new JsonRpcPeer({ send: (m) => sent.push(m as Record<string, unknown>) });
    new AcpAgent(peer, {
      driverFactory: (options, events) => {
        const driver = new FakeDriver(options, events);
        drivers.push(driver);
        return driver;
      },
      newSessionId: () => 'sess_plan',
      onProtocolError: (_id, problem) => { problems.push(problem); report?.(problem); },
    });
    const params = clientCapabilities === undefined ? { protocolVersion: 1 } : { protocolVersion: 1, clientCapabilities };
    await peer.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
    await peer.receive({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    const driver = drivers.at(-1)!;
    const updates = () => sent.filter((m) => m.method === 'session/update').map((m) => (m.params as Record<string, unknown>));
    return { driver, updates, problems };
  }

  it('tells each driver whether the client accepts plan updates', async () => {
    expect((await session({ plan: {} })).driver.options).toMatchObject({ clientCapabilities: { plan: true } });
    expect((await session({ plan: null })).driver.options).toMatchObject({ clientCapabilities: { plan: false } });
    expect((await session(undefined)).driver.options).toMatchObject({ clientCapabilities: { plan: false } });
  });

  it('forwards plan_update and plan_removed to a client that advertised plan', async () => {
    const s = await session({ plan: {} });
    s.driver.emit(itemsUpdate);
    s.driver.emit({ sessionUpdate: 'plan_removed', planId: 'pl_1' });
    expect(s.updates().map((u) => u.update)).toEqual([itemsUpdate, { sessionUpdate: 'plan_removed', planId: 'pl_1' }]);
    for (const params of s.updates()) expect(sessionNotificationProblems(params)).toEqual([]);
  });

  it('turns plan_update into the full-replacement plan for a client that did not', async () => {
    const s = await session({});
    s.driver.emit(itemsUpdate);
    expect(s.updates().map((u) => u.update)).toEqual([
      { sessionUpdate: 'plan', entries: [entry], _meta: { 'particle.academy/plan': { revision: 1 } } },
    ]);
    for (const params of s.updates()) expect(sessionNotificationProblems(params)).toEqual([]);
  });

  it('sends no plan_removed, and no markdown plan_update, to a client that did not advertise plan, and reports it', async () => {
    const s = await session(undefined);
    s.driver.emit({ sessionUpdate: 'plan_removed', planId: 'pl_1' });
    s.driver.emit({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'pl_1', content: '# plan' } });
    s.driver.emit({ sessionUpdate: 'plan_update', delta: 'progress' });
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(3);
  });

  it('refuses a plan_update that is not ACP-shaped even for a client that advertised plan', async () => {
    // The old Codex `{sessionUpdate: 'plan_update', delta}` was this shape.
    const s = await session({ plan: {} });
    s.driver.emit({ sessionUpdate: 'plan_update', delta: 'progress' });
    s.driver.emit({ sessionUpdate: 'plan_update', plan: { type: 'items', entries: [] } });
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(2);
  });

  it.each([{ plan: {} }, {}])('gives a plan entry with no valid priority the neutral one (client %j)', async (caps) => {
    const s = await session(caps);
    s.driver.emit({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }, { content: 'b', priority: 'urgent', status: 'completed' }, { content: 'c', priority: 'high', status: 'pending' }] });
    const update = s.updates()[0]!.update as { entries: Record<string, unknown>[] };
    expect(update.entries.map((e) => e.priority)).toEqual(['medium', 'medium', 'high']);
    expect(sessionNotificationProblems(s.updates()[0])).toEqual([]);
    expect(s.problems).toHaveLength(1);
  });

  it.each([{ plan: {} }, {}])('sends no plan whose entries the ACP schema rejects, and reports each (client %j)', async (caps) => {
    // The gate is the one place every driver's plan leaves. A schema-built client is told the shape is guaranteed
    // and does not guard, so an entry it cannot read must never reach it.
    const s = await session(caps);
    const bad: unknown[][] = [
      [null],
      ['x'],
      [7],
      [[]],
      [{ content: 'a', priority: 'high', status: 'bogus' }],
      [{ content: 'a', priority: 'medium', status: 'failed' }],
      [{ content: 'a', priority: 'medium', status: 'done' }],
      [{ content: 'a', priority: 'medium' }],
      [{ content: 42, priority: 'medium', status: 'pending' }],
      [{ priority: 'medium', status: 'pending' }],
      [entry, { content: 'b', priority: 'medium', status: 'skipped' }],
      [{ ...entry, _meta: 5 }],
      [{ ...entry, _meta: 'x' }],
      [{ ...entry, _meta: [] }],
    ];
    for (const entries of bad) {
      // Each is checked against the schema first, so this cannot pass on an entry that is actually valid.
      expect(sessionUpdateProblems({ sessionUpdate: 'plan', entries })).not.toEqual([]);
      s.driver.emit({ sessionUpdate: 'plan', entries });
      s.driver.emit({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries } });
    }
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(bad.length * 2);
  });

  it.each([{ plan: {} }, {}])('sends no plan whose update or plan _meta the ACP schema rejects (client %j)', async (caps) => {
    const s = await session(caps);
    const bad: Record<string, unknown>[] = [
      { sessionUpdate: 'plan', entries: [entry], _meta: 'x' },
      { sessionUpdate: 'plan', entries: [entry], _meta: 5 },
      { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [entry], _meta: 7 } },
      { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [entry] }, _meta: [] },
    ];
    for (const update of bad) {
      expect(sessionUpdateProblems(update)).not.toEqual([]);
      s.driver.emit(update);
    }
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(bad.length);
  });

  it.each([{ plan: {} }, {}])('reads only an entry\'s own properties (client %j)', async (caps) => {
    // A class instance or an object with a prototype passes a check that reads inherited values, and then loses them
    // when copied: the client receives an entry with no content or status.
    const s = await session(caps);
    const inherited = Object.create({ content: 'a', status: 'pending' }) as Record<string, unknown>;
    inherited.priority = 'medium';
    class Step {
      get content() { return 'a'; }
      get status() { return 'pending'; }
    }
    for (const bad of [inherited, new Step()]) {
      s.driver.emit({ sessionUpdate: 'plan', entries: [bad] });
      s.driver.emit({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [bad] } });
    }
    const markdown = Object.create({ content: '# plan' }) as Record<string, unknown>;
    Object.assign(markdown, { type: 'markdown', planId: 'pl_1' });
    s.driver.emit({ sessionUpdate: 'plan_update', plan: markdown });
    expect(s.updates()).toEqual([]);
    expect(s.problems.length).toBeGreaterThanOrEqual(5);
  });

  it.each([{ plan: {} }, {}])('sends the checked fields, not a copy of what the driver passed (client %j)', async (caps) => {
    const s = await session(caps);
    s.driver.emit({ sessionUpdate: 'plan', entries: [{ ...entry, extra: 'x', _meta: { k: 1 } }], _meta: { m: 1 }, stray: true });
    s.driver.emit({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [{ ...entry, _meta: null }], stray: 1 }, _meta: null });
    const sent = s.updates().map((u) => u.update);
    expect(sent[0]).toEqual({ sessionUpdate: 'plan', entries: [{ ...entry, _meta: { k: 1 } }], _meta: { m: 1 } });
    expect(sent[1]).toEqual(caps.plan
      ? { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [entry] } }
      : { sessionUpdate: 'plan', entries: [entry] });
    for (const params of s.updates()) expect(sessionNotificationProblems(params)).toEqual([]);
  });

  it.each([{ plan: {} }, {}])('sends no plan whose _meta would not serialize as an object, at any level (client %j)', async (caps) => {
    // A plain object can still serialize as something else (an own toJSON), or not serialize at all (a BigInt, a
    // throwing getter, a Proxy that claims a plain prototype). What the wire would carry is what is checked.
    const s = await session(caps);
    const metas: unknown[] = [
      { toJSON() { return 'x'; } },
      { toJSON() { return 7; } },
      { toJSON() { return [1]; } },
      { toJSON() { return null; } },
      { toJSON() { return undefined; } },
      { toJSON() { throw new Error('no'); } },
      { a: 1n },
      { nested: { deeper: 2n } },
      { get a() { throw new Error('no'); } },
      new Proxy({}, { getPrototypeOf: () => Object.prototype, ownKeys: () => { throw new Error('no'); } }),
      new Proxy({}, { getPrototypeOf: () => Object.prototype, get: () => { throw new Error('no'); } }),
    ];
    for (const meta of metas) {
      for (const update of [
        { sessionUpdate: 'plan', entries: [{ ...entry, _meta: meta }] },
        { sessionUpdate: 'plan', entries: [entry], _meta: meta },
        { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [{ ...entry, _meta: meta }] } },
        { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [entry], _meta: meta } },
        { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [entry] }, _meta: meta },
      ]) expect(() => s.driver.emit(update as never)).not.toThrow();
    }
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(metas.length * 5);
  });

  it.each([{ plan: {} }, {}])('sends _meta as it serializes, as a fresh object (client %j)', async (caps) => {
    const s = await session(caps);
    const meta = { when: new Date(0), skip: undefined, inner: { toJSON() { return { k: 1 }; } } };
    s.driver.emit({ sessionUpdate: 'plan', entries: [{ ...entry, _meta: meta }], _meta: meta } as never);
    const sent = s.updates()[0]!.update as { entries: Record<string, unknown>[]; _meta: unknown };
    const wire = { when: '1970-01-01T00:00:00.000Z', inner: { k: 1 } };
    expect(sent._meta).toEqual(wire);
    expect(Object.keys(sent._meta as object)).toEqual(['when', 'inner']);
    expect(sent._meta).not.toBe(meta);
    expect(sent.entries[0]!._meta).toEqual(wire);
    expect(sessionNotificationProblems(s.updates()[0])).toEqual([]);
  });

  it.each([{ plan: {} }, {}])('reports, and does not throw into the driver, a plan whose fields throw when read (client %j)', async (caps) => {
    const s = await session(caps);
    const throwing = (key: string) => Object.defineProperty({ ...entry }, key, { enumerable: true, get() { throw new Error('no'); } });
    const throwingList = new Proxy([entry], { get: () => { throw new Error('no'); } });
    const throwingPlan = new Proxy({ type: 'items', planId: 'pl_1', entries: [entry] }, { getOwnPropertyDescriptor: () => { throw new Error('no'); } });
    const bad: unknown[] = [
      { sessionUpdate: 'plan', entries: [throwing('content')] },
      { sessionUpdate: 'plan', entries: [throwing('status')] },
      { sessionUpdate: 'plan', entries: [throwing('_meta')] },
      { sessionUpdate: 'plan', entries: throwingList },
      Object.defineProperty({ sessionUpdate: 'plan', entries: [entry] }, '_meta', { enumerable: true, get() { throw new Error('no'); } }),
      { sessionUpdate: 'plan_update', plan: throwingPlan },
      { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [throwing('priority')] } },
      Object.defineProperty({ sessionUpdate: 'plan_removed' }, 'planId', { enumerable: true, get() { throw new Error('no'); } }),
    ];
    for (const update of bad) expect(() => s.driver.emit(update as never)).not.toThrow();
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(bad.length);
  });

  it.each([{ plan: {} }, {}])('checks and sends the same kind: a getter cannot turn a chunk into an unchecked plan (client %j)', async (caps) => {
    const s = await session(caps);
    const flipping = () => {
      let reads = 0;
      return Object.defineProperty({ content: { type: 'text', text: 'hi' }, entries: [{ content: 'x', status: 'bogus' }] }, 'sessionUpdate', {
        enumerable: true,
        get() { reads += 1; return reads === 1 ? 'agent_message_chunk' : 'plan'; },
      });
    };
    const proxied = () => {
      let reads = 0;
      return new Proxy({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as Record<string, unknown>, {
        get(target, key) { if (key === 'sessionUpdate') { reads += 1; return reads === 1 ? 'agent_message_chunk' : 'plan_removed'; } return target[key as string]; },
      });
    };
    s.driver.emit(flipping() as never);
    s.driver.emit(proxied() as never);
    // The kind is checked on the first read and again on the serialization that is sent; one that changes between
    // the two is not sent at all, and that is reported.
    expect(s.updates()).toEqual([]);
    expect(s.problems).toEqual([
      'update was not sent: it does not serialize as an object of the kind it declares',
      'update was not sent: it does not serialize as an object of the kind it declares',
    ]);
  });

  it.each([{ plan: {} }, {}])('sends what it checked: an own toJSON cannot replace a chunk with a plan (client %j)', async (caps) => {
    // The transport serializes with JSON.stringify, which calls an own toJSON. What is sent must be what the gate
    // checked, so the update is read as it serializes, and one that serializes as another kind is refused.
    const s = await session(caps);
    const chunk = (wire: unknown) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' }, toJSON: () => wire });
    s.driver.emit(chunk({ sessionUpdate: 'plan_removed', planId: 'pl_x', extra: 1 }) as never);
    s.driver.emit(chunk({ sessionUpdate: 'plan', entries: [{ content: 5, status: 'bogus' }] }) as never);
    s.driver.emit(chunk(undefined) as never);
    s.driver.emit(chunk('agent_message_chunk') as never);
    expect(() => s.driver.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi', n: BigInt(1) } } as never)).not.toThrow();
    expect(s.updates()).toEqual([]);
    expect(s.problems).toEqual(Array(5).fill('update was not sent: it does not serialize as an object of the kind it declares'));
    // One whose toJSON keeps the kind is sent as that serialization: a plain object, never the driver's own.
    const same = chunk({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'serialized' } });
    s.driver.emit(same as never);
    const sent = s.updates()[0]!.update as Record<string, unknown>;
    expect(sent).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'serialized' } });
    expect(sent).not.toBe(same);
    expect(Object.hasOwn(sent, 'toJSON')).toBe(false);
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
    expect(sessionNotificationProblems(JSON.parse(JSON.stringify(s.updates()[0])))).toEqual([]);
    expect(s.problems).toHaveLength(5);
  });

  it.each([{ plan: {} }, {}])('refuses, and reports, an entry content or a _meta over the documented caps (client %j)', async (caps) => {
    const s = await session(caps);
    expect(PLAN_ENTRY_CONTENT_MAX).toBe(1024);
    expect(PLAN_META_MAX_BYTES).toBe(16384);
    // JSON {"k":"..."} is eight bytes around the value; é is two bytes in UTF-8 and one code point.
    const meta = (bytes: number) => ({ k: 'x'.repeat(bytes - 8) });
    const wideMeta = { k: 'é'.repeat(8189) }; // 16386 bytes, 8197 characters
    const full = { content: 'é'.repeat(PLAN_ENTRY_CONTENT_MAX), priority: 'medium', status: 'pending', _meta: meta(PLAN_META_MAX_BYTES) };
    s.driver.emit({ sessionUpdate: 'plan', entries: [full], _meta: meta(PLAN_META_MAX_BYTES) } as never);
    expect(s.updates()).toHaveLength(1);
    expect(s.problems).toEqual([]);
    const over = { ...full, content: full.content + 'x' };
    const bad: unknown[] = [
      { sessionUpdate: 'plan', entries: [over] },
      { sessionUpdate: 'plan', entries: [{ ...full, _meta: meta(PLAN_META_MAX_BYTES + 1) }] },
      { sessionUpdate: 'plan', entries: [{ ...full, _meta: wideMeta }] },
      { sessionUpdate: 'plan', entries: [full], _meta: meta(PLAN_META_MAX_BYTES + 1) },
      { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [over] } },
      { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [full], _meta: meta(PLAN_META_MAX_BYTES + 1) } },
      { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'pl_1', entries: [full] }, _meta: wideMeta },
      { sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: meta(PLAN_META_MAX_BYTES + 1) },
    ];
    for (const update of bad) expect(() => s.driver.emit(update as never)).not.toThrow();
    expect(s.updates()).toHaveLength(1);
    expect(s.problems).toHaveLength(bad.length);
    // A client without plan support is refused plan_removed before its _meta is read; every other refusal names the cap.
    for (const problem of 'plan' in caps ? s.problems : s.problems.slice(0, -1)) expect(problem).toMatch(/larger than/);
  });

  it('does not send an update whose kind is not its own string', async () => {
    const s = await session({ plan: {} });
    const inherited = Object.assign(Object.create({ sessionUpdate: 'plan' }) as Record<string, unknown>, { entries: [{ content: 'x', status: 'bogus' }] });
    s.driver.emit(inherited as never);
    s.driver.emit({ sessionUpdate: 7 } as never);
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(2);
  });

  it.each([{ plan: {} }, {}])('a host reporter that throws neither reaches the driver nor relabels the problem (client %j)', async (caps) => {
    const s = await session(caps, () => { throw new Error('reporter'); });
    expect(() => s.driver.emit({ sessionUpdate: 'plan' } as never)).not.toThrow();
    expect(s.problems).toEqual(['plan update without an entries list was not sent']);
    const throwing = Object.defineProperty({ sessionUpdate: 'plan_removed' }, 'planId', { enumerable: true, get() { throw new Error('no'); } });
    expect(() => s.driver.emit(throwing as never)).not.toThrow();
    expect(s.problems).toEqual(['plan update without an entries list was not sent', 'plan update was not sent: reading it threw']);
    // A correction is still sent when reporting it throws.
    expect(() => s.driver.emit({ sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending' }] } as never)).not.toThrow();
    expect(s.updates().map((u) => (u.update as { entries: unknown }).entries)).toEqual([[{ content: 'x', priority: 'medium', status: 'pending' }]]);
  });

  it('holds plan_removed to the same rules: own planId, checked _meta, only the checked fields sent', async () => {
    const s = await session({ plan: {} });
    const inherited = Object.assign(Object.create({ planId: 'pl_2' }) as Record<string, unknown>, { sessionUpdate: 'plan_removed' });
    const bad: unknown[] = [
      inherited,
      { sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: 5 },
      { sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: 'x' },
      { sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: [] },
      { sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: { toJSON() { return 'x'; } } },
      { sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: { a: 1n } },
      { sessionUpdate: 'plan_removed', planId: 7 },
    ];
    for (const update of bad) s.driver.emit(update as never);
    expect(s.updates()).toEqual([]);
    expect(s.problems).toHaveLength(bad.length);
    const meta = { k: 1 };
    s.driver.emit({ sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: meta, extra: 'x' } as never);
    s.driver.emit({ sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: null } as never);
    const sent = s.updates().map((u) => u.update);
    expect(sent).toEqual([{ sessionUpdate: 'plan_removed', planId: 'pl_1', _meta: { k: 1 } }, { sessionUpdate: 'plan_removed', planId: 'pl_1' }]);
    expect((sent[0] as { _meta: unknown })._meta).not.toBe(meta);
    for (const params of s.updates()) expect(sessionNotificationProblems(params)).toEqual([]);
  });
});
