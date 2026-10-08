import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers, CodexTransportOptions } from '../src/codex/transport.js';
import { serve } from '../src/acp/stdio.js';
import { META_CLI_SESSION_ID, META_EXEC_POLICY_AMENDMENT, META_UNMAPPED_FRAME } from '../src/meta.js';
import { encodeLine } from '../src/ndjson.js';
import { readCodexRateLimit } from '../src/codex/rate-limit.js';

class FakeTransport implements CodexTransport {
  readonly sent: Record<string, unknown>[] = [];
  #handlers: CodexTransportHandlers;
  #turnPage = 0;

  constructor(handlers: CodexTransportHandlers) {
    this.#handlers = handlers;
  }

  async start(): Promise<void> {}

  send(raw: unknown): void {
    const frame = raw as Record<string, unknown>;
    this.sent.push(frame);
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    const params = frame.params as Record<string, unknown> | undefined;
    let result: unknown = {};
    switch (frame.method) {
      case 'thread/start':
        result = { thread: { id: 'thread-captured' } };
        break;
      case 'thread/resume':
        result = { thread: { id: params?.threadId } };
        break;
      case 'account/rateLimits/read':
        result = {
          ordinaryUsageAllowed: true,
          rateLimits: {
            primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: null,
          },
        };
        break;
      case 'thread/turns/list':
        this.#turnPage += 1;
        result = this.#turnPage === 1
          ? { data: [{ id: 'turn-history' }], nextCursor: 'turn-cursor' }
          : { data: [{ id: 'turn-history-2' }], nextCursor: null };
        break;
      case 'thread/items/list':
        result = {
          data: [{ item: { type: 'agentMessage', id: 'item-history', text: 'remembered' } }],
          nextCursor: null,
        };
        break;
      case 'turn/start':
        result = { turn: { id: 'turn-live' } };
        break;
    }
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }

  close(): void {}

  frame(value: unknown): void {
    this.#handlers.onFrame(value);
  }
}

function setup(options: { resumeSessionId?: string } = {}, events: ConstructorParameters<typeof CodexDriver>[1] = {}) {
  let transport!: FakeTransport;
  const factory: CodexTransportFactory = (_options: CodexTransportOptions, handlers) => {
    transport = new FakeTransport(handlers);
    return transport;
  };
  const updates: Record<string, unknown>[] = [];
  const turnEnds: unknown[] = [];
  const driver = new CodexDriver(
    { cwd: 'C:\\work', parentEnv: {}, ...options },
    { ...events, onUpdate: (update) => updates.push(update), onTurnEnd: (result) => turnEnds.push(result) },
    factory,
  );
  return { driver, get transport() { return transport; }, updates, turnEnds };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('CodexDriver', () => {
  afterEach(() => vi.restoreAllMocks());

  it('captures the provider id and exposes it on the first session update', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;

    expect(state.driver.cliSessionId).toBe('thread-captured');
    expect(state.updates[0]).toMatchObject({
      _meta: { [META_CLI_SESSION_ID]: 'thread-captured' },
    });
  });

  it('refuses a server-minted ACP id before opening a transport', () => {
    const state = setup({ resumeSessionId: 'sess_1_1234' });
    state.driver.start();
    expect(state.transport).toBeUndefined();
  });

  it('resumes the captured id and replays history through paged endpoints', async () => {
    const state = setup({ resumeSessionId: 'thread-captured' });
    state.driver.start();
    await state.driver.ready;

    const calls = state.transport.sent.filter((frame) => typeof frame.method === 'string');
    expect(calls.find((frame) => frame.method === 'thread/resume')).toMatchObject({
      params: { threadId: 'thread-captured', excludeTurns: true },
    });
    expect(calls.find((frame) => frame.method === 'thread/turns/list')).toMatchObject({
      params: { threadId: 'thread-captured', sortDirection: 'asc', itemsView: 'none' },
    });
    expect(calls.find((frame) => frame.method === 'thread/items/list')).toMatchObject({
      params: { threadId: 'thread-captured', turnId: 'turn-history' },
    });
    expect(calls.some((frame) => (frame.params as Record<string, unknown> | undefined)?.cursor === 'turn-cursor')).toBe(true);
    expect(state.updates.some((update) => update.sessionUpdate === 'session_message')).toBe(true);
  });

  it('preserves the execpolicy argv on its own ACP permission option', async () => {
    let resolvePermission!: (value: { outcome: 'selected'; optionId: string }) => void;
    const onRequestPermission = vi.fn(() => new Promise<{ outcome: 'selected'; optionId: string }>((resolve) => {
      resolvePermission = resolve;
    }));
    const state = setup({}, { onRequestPermission });
    state.driver.start();
    await state.driver.ready;

    state.transport.frame({
      jsonrpc: '2.0',
      id: 74,
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-safe',
        command: ['git', 'status'],
        availableDecisions: ['accept', 'cancel', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } }],
      },
    });
    await settle();

    const permission = onRequestPermission.mock.calls[0]?.[0];
    expect(permission?.options).toHaveLength(3);
    const remembered = permission?.options.find((option) => META_EXEC_POLICY_AMENDMENT in (option._meta ?? {}));
    expect(remembered?._meta?.[META_EXEC_POLICY_AMENDMENT]).toEqual(['git', 'status']);
    resolvePermission({ outcome: 'selected', optionId: remembered?.optionId ?? '' });
    await settle();

    expect(state.transport.sent.find((frame) => frame.id === 74)).toMatchObject({
      result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } } },
    });
  });

  it('treats a declined item as the turn boundary', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await settle();
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: 'item-denied', command: ['do'], status: 'declined' } },
    });

    expect(state.turnEnds).toHaveLength(1);
    expect(state.turnEnds[0]).toMatchObject({ stopReason: 'cancelled', raw: 'declined' });
    expect(state.updates.find((update) => update.toolCallId === 'item-denied')).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'failed',
    });
  });

  it('emits a complete assistant item when no deltas were received', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'message-without-deltas', text: 'complete answer', status: 'completed' } },
    });
    expect(state.updates).toContainEqual({
      sessionUpdate: 'session_message',
      content: [{ type: 'text', text: 'complete answer' }],
    });
  });

  it('records malformed frame length without exposing its content', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.transport.frame('{"secret-prompt-and-credentials":');
    const unmapped = state.updates.find((update) => META_UNMAPPED_FRAME in (update._meta ?? {}));
    expect(unmapped).toBeDefined();
    expect(JSON.stringify(unmapped)).not.toContain('secret-prompt-and-credentials');
    expect(JSON.stringify(unmapped)).toContain('string(');
  });

  it('reports Codex percentage without applying Claude fractions', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    const rate = state.updates.find((update) => update.sessionUpdate === 'notice' && 'particle.academy/rate_limit' in (update._meta ?? {}));
    expect(rate?._meta?.['particle.academy/rate_limit']).toMatchObject({
      primary: { usedPercent: 45, windowDurationMins: 300 },
    });
  });

  it('names the percentage field that makes a rate-limit payload invalid', () => {
    const read = readCodexRateLimit({
      ordinaryUsageAllowed: true,
      rateLimits: {
        primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
      },
    });
    expect(read).toMatchObject({ ok: false, reason: expect.stringContaining('rateLimits.primary.usedPercent') });
  });

  it('sends cancel synchronously when the ACP client disconnects with approval pending', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputFrames: Record<string, unknown>[] = [];
    let outputText = '';
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString();
      const lines = outputText.split('\n');
      outputText = lines.pop() ?? '';
      for (const line of lines) if (line.length > 0) outputFrames.push(JSON.parse(line) as Record<string, unknown>);
    });

    let transport!: FakeTransport;
    const factory: CodexTransportFactory = (_options, handlers) => (transport = new FakeTransport(handlers));
    const { agent } = serve({
      input,
      output,
      driverFactory: (options, events) => new CodexDriver({ ...options, parentEnv: {} }, events, factory),
    });
    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
    input.write(encodeLine({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:\\work' } }));
    await settle();
    await settle();
    expect(outputFrames.some((frame) => frame.id === 2)).toBe(true);

    transport.frame({
      jsonrpc: '2.0',
      id: 88,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'pending-safe', command: ['git', 'status'], availableDecisions: ['accept', 'cancel'] },
    });
    await settle();
    expect(outputFrames.some((frame) => frame.method === 'session/request_permission')).toBe(true);

    const inputClosed = new Promise<void>((resolve) => input.once('close', () => resolve()));
    input.destroy();
    await inputClosed;
    expect(transport.sent.find((frame) => frame.id === 88)).toMatchObject({
      result: { decision: 'cancel' },
    });
    expect(agent.sessionIds).toEqual([]);
  });
});
