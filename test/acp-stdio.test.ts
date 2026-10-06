/**
 * The whole ACP conversation, over a pair of in-memory streams.
 *
 * This is the closest thing to the real thing that runs in CI: a client writes
 * NDJSON in, reads NDJSON out, and never knows there is no pipe. Everything
 * between framing and session bookkeeping is exercised at once, which is
 * exactly what the per-module tests cannot do -- they each prove their own
 * piece and none of them proves the pieces are joined.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serve } from '../src/acp/stdio.js';
import type { AgentDriver, DriverEvents } from '../src/acp/agent.js';
import { encodeLine } from '../src/ndjson.js';

class FakeDriver implements AgentDriver {
  cliSessionId: string | null = 'cli-1';
  withheldCredentials: readonly string[] = ['ANTHROPIC_API_KEY'];
  readonly prompts: string[] = [];
  killed = false;

  constructor(
    readonly options: { cwd: string; resumeSessionId?: string },
    readonly events: DriverEvents,
  ) {}

  start(): void {}
  endInput(): void {}
  kill(): void {
    this.killed = true;
  }

  prompt(text: string): void {
    this.prompts.push(text);
    // Answer like a real agent: stream a chunk, report usage, end the turn.
    this.events.onUpdate?.({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `echo: ${text}` },
    });
    this.events.onUpdate?.({ sessionUpdate: 'usage_update', used: 12, size: 200_000 });
    this.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: 'end_turn' });
  }
}

/** A client speaking NDJSON over the two streams, collecting what comes back. */
function client() {
  const input = new PassThrough();
  const output = new PassThrough();
  const drivers: FakeDriver[] = [];
  const received: Record<string, unknown>[] = [];

  output.setEncoding('utf8');
  let buffer = '';
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) received.push(JSON.parse(line) as Record<string, unknown>);
      newline = buffer.indexOf('\n');
    }
  });

  const served = serve({
    input,
    output,
    driverFactory: (options, events) => {
      const driver = new FakeDriver(options, events);
      drivers.push(driver);
      return driver;
    },
    newSessionId: () => `sess_${drivers.length + 1}`,
  });

  /** Send a request and wait for its reply to arrive on the output stream. */
  async function request(id: number, method: string, params?: unknown) {
    input.write(encodeLine({ jsonrpc: '2.0', id, method, params }));
    for (let tick = 0; tick < 200; tick++) {
      const reply = received.find((m) => m.id === id);
      if (reply !== undefined) return reply;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`no reply to ${method} (id ${id})`);
  }

  return { input, output, drivers, received, served, request };
}

describe('a full conversation over a pipe', () => {
  it('initializes, opens a session, prompts, and streams updates back', async () => {
    const c = client();

    const init = await c.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect((init.result as Record<string, unknown>).protocolVersion).toBe(1);

    const opened = await c.request(2, 'session/new', { cwd: '/work', mcpServers: [] });
    const sessionId = (opened.result as Record<string, string>).sessionId;
    expect(sessionId).toBe('sess_1');

    const prompted = await c.request(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(prompted.result).toEqual({ stopReason: 'end_turn' });

    // The notifications must have arrived BEFORE the reply, or a client that
    // renders on the reply shows an empty turn.
    const notes = c.received.filter((m) => m.method === 'session/update');
    expect(notes).toHaveLength(2);
    expect(c.received.indexOf(notes[0]!)).toBeLessThan(c.received.indexOf(prompted));

    const kinds = notes.map(
      (m) => ((m.params as Record<string, Record<string, unknown>>).update as Record<string, unknown>)
        .sessionUpdate,
    );
    expect(kinds).toEqual(['agent_message_chunk', 'usage_update']);
  });

  it('tags every notification with the session it belongs to', async () => {
    // Two agents in one room share this stream. An update without a sessionId,
    // or with the wrong one, lands in the wrong conversation.
    const c = client();
    await c.request(1, 'session/new', { cwd: '/a', mcpServers: [] });
    await c.request(2, 'session/new', { cwd: '/b', mcpServers: [] });

    await c.request(3, 'session/prompt', {
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'to A' }],
    });
    await c.request(4, 'session/prompt', {
      sessionId: 'sess_2',
      prompt: [{ type: 'text', text: 'to B' }],
    });

    const bySession = new Map<string, string[]>();
    for (const note of c.received.filter((m) => m.method === 'session/update')) {
      const params = note.params as { sessionId: string; update: Record<string, unknown> };
      const texts = bySession.get(params.sessionId) ?? [];
      const content = params.update.content as { text?: string } | undefined;
      if (content?.text !== undefined) texts.push(content.text);
      bySession.set(params.sessionId, texts);
    }

    expect(bySession.get('sess_1')).toEqual(['echo: to A']);
    expect(bySession.get('sess_2')).toEqual(['echo: to B']);
  });

  it('writes one JSON value per line, asserted on the RAW bytes', async () => {
    // The transport is line-delimited. A message containing a literal newline,
    // or two messages sharing a line, breaks a conforming reader while ours
    // keeps working -- which is worse than breaking.
    //
    // Asserted on the raw stream deliberately. The first version of this test
    // re-serialised what the client had already parsed off whole lines, so it
    // could not fail: it proved that JSON.stringify does not emit newlines.
    const input = new PassThrough();
    const output = new PassThrough();
    let raw = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      raw += chunk;
    });

    serve({
      input,
      output,
      driverFactory: (o, e) => new FakeDriver(o, e),
      newSessionId: () => 'sess_1',
    });

    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    input.write(
      encodeLine({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/w', mcpServers: [] } }),
    );
    // A prompt whose text contains newlines: the reply echoes it, so a literal
    // newline would reach the wire if anything forgot to escape.
    input.write(
      encodeLine({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'multi\nline\nprompt' }] },
      }),
    );

    for (let tick = 0; tick < 200; tick++) await new Promise((r) => setImmediate(r));

    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(3);
    // Every line must be exactly one complete JSON value.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // And the echoed newlines must have survived as escapes, not as breaks.
    expect(raw).toContain('multi\\nline\\nprompt');
  });

  it('refuses a malformed line without dropping the connection', async () => {
    const problems: string[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    const served = serve({
      input,
      output,
      driverFactory: (o, e) => new FakeDriver(o, e),
      onProtocolError: (_id, problem) => problems.push(problem),
    });

    input.write('{this is not json\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not valid JSON/);

    // And the server still works afterwards.
    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(served.peer.failed).toBe(false);
  });

  it('kills every session when the client disconnects', async () => {
    // Otherwise an agent process keeps running with nobody listening to it.
    const c = client();
    await c.request(1, 'session/new', { cwd: '/a', mcpServers: [] });
    await c.request(2, 'session/new', { cwd: '/b', mcpServers: [] });

    c.input.end();
    await c.served.closed;

    expect(c.drivers.map((d) => d.killed)).toEqual([true, true]);
    expect(c.served.agent.sessionIds).toEqual([]);
    expect(c.served.peer.failed).toBe(true);
  });
});
