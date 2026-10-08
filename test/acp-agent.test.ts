import { describe, expect, it, vi } from 'vitest';
import { AcpAgent, PROTOCOL_VERSION, type AcpAgentOptions, type AgentDriver, type DriverEvents } from '../src/acp/agent.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';
import type { TurnOutcome } from '../src/claude/driver.js';

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

function harness(probeSession?: AcpAgentOptions['probeSession']) {
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
