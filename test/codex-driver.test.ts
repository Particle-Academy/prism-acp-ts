import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_DRIVER_CAPABILITIES, CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers, CodexTransportOptions } from '../src/codex/transport.js';
import { serve } from '../src/acp/stdio.js';
import {
  META_CLI_SESSION_ID,
  META_DRIVER_CAPABILITIES,
  META_EXEC_POLICY_AMENDMENT,
  META_UNMAPPED_FRAME,
} from '../src/meta.js';
import { encodeLine } from '../src/ndjson.js';
import { readCodexRateLimit } from '../src/codex/rate-limit.js';

class FakeTransport implements CodexTransport {
  readonly sent: Record<string, unknown>[] = [];
  #handlers: CodexTransportHandlers;
  #turnPage = 0;
  #historyItems: readonly Record<string, unknown>[];
  #singleHistoryTurn: boolean;

  constructor(
    handlers: CodexTransportHandlers,
    historyItems: readonly Record<string, unknown>[] = [
      { item: { type: 'agentMessage', id: 'item-history', text: 'remembered' } },
    ],
    singleHistoryTurn = false,
  ) {
    this.#handlers = handlers;
    this.#historyItems = historyItems;
    this.#singleHistoryTurn = singleHistoryTurn;
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
        result = this.#singleHistoryTurn
          ? { data: [{ id: 'turn-history' }], nextCursor: null }
          : this.#turnPage === 1
            ? { data: [{ id: 'turn-history' }], nextCursor: 'turn-cursor' }
            : { data: [{ id: 'turn-history-2' }], nextCursor: null };
        break;
      case 'thread/items/list':
        result = {
          data: this.#historyItems,
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

function setup(
  options: { resumeSessionId?: string; turnInactivityTimeoutMs?: number } = {},
  events: ConstructorParameters<typeof CodexDriver>[1] = {},
  historyItems?: readonly Record<string, unknown>[],
  singleHistoryTurn = false,
) {
  let transport!: FakeTransport;
  const factory: CodexTransportFactory = (_options: CodexTransportOptions, handlers) => {
    transport = new FakeTransport(handlers, historyItems, singleHistoryTurn);
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function permissionHarness() {
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
    driverCapabilities: CODEX_DRIVER_CAPABILITIES,
    driverFactory: (options, events) => new CodexDriver({ ...options, parentEnv: {} }, events, factory),
  });
  input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
  input.write(encodeLine({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/work' } }));
  await settle();
  await settle();
  expect(outputFrames.some((frame) => frame.id === 2)).toBe(true);

  transport.frame({
    jsonrpc: '2.0',
    id: 88,
    method: 'item/commandExecution/requestApproval',
    params: {
      itemId: 'approval-item',
      turnId: 'turn-live',
      command: ['git', 'status'],
      availableDecisions: ['accept', 'cancel', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } }],
    },
  });
  await settle();
  const permissionRequest = outputFrames.find((frame) => frame.method === 'session/request_permission');
  expect(permissionRequest).toBeDefined();
  const initializeResult = outputFrames.find((frame) => frame.id === 1)?.result as Record<string, unknown>;
  expect((initializeResult?._meta as Record<string, unknown>)?.[META_DRIVER_CAPABILITIES]).toEqual(CODEX_DRIVER_CAPABILITIES);
  return {
    input,
    outputFrames,
    transport,
    permissionRequest: permissionRequest as Record<string, unknown>,
    answer: async (result: unknown) => {
      input.write(encodeLine({ jsonrpc: '2.0', id: permissionRequest?.id, result }));
      await settle();
      return transport.sent.find((frame) => frame.id === 88);
    },
    close: () => input.destroy(),
  };
}

describe('CodexDriver', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('declares permissionRequests when the Codex fixture sends session/request_permission', async () => {
    const state = await permissionHarness();
    const observed = state.outputFrames.some((frame) => frame.method === 'session/request_permission');
    expect(CODEX_DRIVER_CAPABILITIES.permissionRequests).toBe(observed);
    const result = await state.answer({ outcome: { outcome: 'selected', optionId: 'codex-accept' } });

    expect(result).toMatchObject({ result: { decision: 'accept' } });
    state.close();
  });

  it('preserves the execpolicy amendment choice and argv across the ACP seam', async () => {
    const state = await permissionHarness();
    const result = await state.answer({ outcome: { outcome: 'selected', optionId: 'codex-accept-amendment' } });

    expect(result).toMatchObject({
      result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } } },
    });
    state.close();
  });

  it('emits one full user message when a live item starts and completes', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    const item = {
      type: 'userMessage',
      id: 'user-message-live',
      content: [{ type: 'text', text: 'the full client prompt' }],
    };
    state.transport.frame({ jsonrpc: '2.0', method: 'item/started', params: { item } });
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { item: { ...item, status: 'completed' } },
    });

    const userMessages = state.updates.filter((update) => update.sessionUpdate === 'user_message_chunk');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'the full client prompt' },
    });
  });

  it('emits one user message for a replayed history item', async () => {
    const state = setup(
      { resumeSessionId: 'thread-captured' },
      {},
      [{ item: {
        type: 'userMessage',
        id: 'user-message-history',
        content: [{ type: 'text', text: 'remembered client prompt' }],
      } }],
      true,
    );
    state.driver.start();
    await state.driver.ready;

    const userMessages = state.updates.filter((update) => update.sessionUpdate === 'user_message_chunk');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'remembered client prompt' },
    });
  });

  it('records one unmapped frame for a live user message with no text', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    const item = { type: 'userMessage', id: 'user-message-empty', content: [] };
    state.transport.frame({ jsonrpc: '2.0', method: 'item/started', params: { item } });
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { item: { ...item, status: 'completed' } },
    });

    const unmapped = state.updates.filter((update) =>
      (update._meta?.[META_UNMAPPED_FRAME] as Record<string, unknown> | undefined)?.reason ===
        'Codex userMessage had no text content');
    expect(unmapped).toHaveLength(1);
  });

  it('sends cancel when the ACP client cancels a permission request', async () => {
    const state = await permissionHarness();
    const result = await state.answer({ outcome: { outcome: 'cancelled' } });

    expect(result).toMatchObject({ result: { decision: 'cancel' } });
    state.close();
  });

  it('sends cancel when the ACP client selects an option Codex did not offer', async () => {
    const state = await permissionHarness();
    const result = await state.answer({ outcome: { outcome: 'selected', optionId: 'not-offered' } });

    expect(result).toMatchObject({ result: { decision: 'cancel' } });
    state.close();
  });

  it('cancels an original approval once when Codex reuses its active request id', async () => {
    const state = await permissionHarness();
    state.transport.frame({
      jsonrpc: '2.0',
      id: 88,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'duplicate-approval', command: ['git', 'status'], availableDecisions: ['accept', 'cancel'] },
    });
    await settle();

    expect(state.transport.sent.filter((frame) => frame.id === 88)).toEqual([
      expect.objectContaining({ result: { decision: 'cancel' } }),
    ]);
    await state.answer({ outcome: { outcome: 'selected', optionId: 'codex-accept' } });
    expect(state.transport.sent.filter((frame) => frame.id === 88)).toHaveLength(1);
    state.close();
  });

  it('ends an inactive turn at the configured deadline and records the deadline', async () => {
    vi.useFakeTimers();
    const state = setup({ turnInactivityTimeoutMs: 50 });
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(50);

    expect(state.turnEnds).toEqual([{ stopReason: null, isError: true, raw: 'turn deadline' }]);
    expect(state.updates.some((update) => update.sessionUpdate === 'notice' &&
      (update.notice as Record<string, unknown> | undefined)?.message?.toString().includes('deadline'))).toBe(true);
    expect(state.updates.some((update) => META_UNMAPPED_FRAME in (update._meta ?? {}) &&
      (update._meta?.[META_UNMAPPED_FRAME] as Record<string, unknown> | undefined)?.reason === 'Codex turn deadline expired')).toBe(true);
    state.driver.kill();
  });

  it('uses the shipped ten-minute default inactivity deadline', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(599_999);
    expect(state.turnEnds).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.turnEnds).toEqual([{ stopReason: null, isError: true, raw: 'turn deadline' }]);
    state.driver.kill();
  });

  it('does not expire while a command execution item is still running', async () => {
    vi.useFakeTimers();
    const state = setup({ turnInactivityTimeoutMs: 50 });
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await flushMicrotasks();
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'item/started',
      params: { turnId: 'turn-live', item: { type: 'commandExecution', id: 'command-running', command: 'npm test' } },
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(state.turnEnds).toHaveLength(0);
    state.driver.kill();
  });

  it('resumes a fresh inactivity deadline when a command execution item completes', async () => {
    vi.useFakeTimers();
    const state = setup({ turnInactivityTimeoutMs: 50 });
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await flushMicrotasks();
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'item/started',
      params: { turnId: 'turn-live', item: { type: 'commandExecution', id: 'command-running', command: 'npm test' } },
    });
    await vi.advanceTimersByTimeAsync(500);
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        turnId: 'turn-live',
        item: { type: 'commandExecution', id: 'command-running', command: 'npm test', status: 'completed', exitCode: 0 },
      },
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(state.turnEnds).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.turnEnds).toEqual([{ stopReason: null, isError: true, raw: 'turn deadline' }]);
    state.driver.kill();
  });

  it('resets the inactivity deadline when a frame arrives for the active turn', async () => {
    vi.useFakeTimers();
    const state = setup({ turnInactivityTimeoutMs: 50 });
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(30);
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'turn/plan/updated',
      params: { turnId: 'turn-live', plan: [{ step: 'working', status: 'inProgress' }] },
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(state.turnEnds).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(20);
    expect(state.turnEnds).toEqual([{ stopReason: null, isError: true, raw: 'turn deadline' }]);
    state.driver.kill();
  });

  it('suspends the inactivity deadline while an approval is pending, then resumes it', async () => {
    vi.useFakeTimers();
    let resolvePermission!: (value: { outcome: 'selected'; optionId: string }) => void;
    const onRequestPermission = () => new Promise<{ outcome: 'selected'; optionId: string }>((resolve) => {
      resolvePermission = resolve;
    });
    const state = setup({ turnInactivityTimeoutMs: 50 }, { onRequestPermission });
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await flushMicrotasks();
    state.transport.frame({
      jsonrpc: '2.0',
      id: 74,
      method: 'item/commandExecution/requestApproval',
      params: {
        turnId: 'turn-live',
        itemId: 'pending-safe',
        command: ['git', 'status'],
        availableDecisions: ['accept', 'cancel'],
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(100);
    expect(state.turnEnds).toHaveLength(0);

    resolvePermission({ outcome: 'selected', optionId: 'codex-accept' });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(49);
    expect(state.turnEnds).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.turnEnds).toEqual([{ stopReason: null, isError: true, raw: 'turn deadline' }]);
    state.driver.kill();
  });

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

  it('declares transcriptReplay when the Codex history fixture emits session_message', async () => {
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
    const replayed = state.updates.some((update) => update.sessionUpdate === 'session_message');
    expect(CODEX_DRIVER_CAPABILITIES.transcriptReplay).toBe(replayed);
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

  it('does not echo a refused rate-limit payload into unmapped metadata', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'account/rateLimits/updated',
      params: { rateLimits: { primary: { usedPercent: -1, windowDurationMins: 300 } }, privateField: 'must-not-echo' },
    });

    const unmapped = state.updates.find((update) => META_UNMAPPED_FRAME in (update._meta ?? {}) &&
      (update._meta?.[META_UNMAPPED_FRAME] as Record<string, unknown> | undefined)?.reason?.toString().includes('usedPercent'));
    expect(unmapped).toBeDefined();
    expect(JSON.stringify(unmapped)).not.toContain('must-not-echo');
    expect((unmapped?._meta?.[META_UNMAPPED_FRAME] as Record<string, unknown> | undefined)?.frame).toEqual({
      method: 'account/rateLimits',
    });
  });

  it('names the percentage field that makes a rate-limit payload invalid', () => {
    const read = readCodexRateLimit({
      ordinaryUsageAllowed: true,
      rateLimits: {
        primary: { usedPercent: -1, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
      },
    });
    expect(read).toMatchObject({ ok: false, reason: expect.stringContaining('rateLimits.primary.usedPercent') });
  });

  it('preserves Codex usage above 100 percent', () => {
    // Overage is real state; rejecting or capping it would hide the reading a human needs.
    const read = readCodexRateLimit({
      rateLimits: {
        primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
      },
    });

    expect(read).toMatchObject({ ok: true, limit: { primary: { usedPercent: 120 } } });
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
