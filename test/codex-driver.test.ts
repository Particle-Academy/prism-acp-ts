import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_DRIVER_CAPABILITIES, CodexDriver, type CodexDriverOptions, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers, CodexTransportOptions } from '../src/codex/transport.js';
import { serve } from '../src/acp/stdio.js';
import {
  META_CLI_SESSION_ID,
  META_DRIVER_CAPABILITIES,
  META_EXEC_POLICY_AMENDMENT,
  META_PERMISSION_REASON,
  META_UNMAPPED_FRAME,
} from '../src/meta.js';
import { encodeLine } from '../src/ndjson.js';
import { readCodexRateLimit } from '../src/codex/rate-limit.js';

class FakeTransport implements CodexTransport {
  readonly sent: Record<string, unknown>[] = [];
  /** How many times the driver closed (killed) the app-server. A turn cancel must leave this at 0. */
  closes = 0;
  /** When set, turn/interrupt is answered with this JSON-RPC error instead of the documented `{}`. */
  interruptError: { code: number; message: string } | null = null;
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
      case 'model/list':
        // Two pages, as the app-server pages them; the second holds a hidden model the driver must leave out.
        result = params?.cursor === null || params?.cursor === undefined
          ? { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Workhorse.', isDefault: true, hidden: false }], nextCursor: 'models-2' }
          : { data: [
            { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast.', isDefault: false, hidden: false },
            { id: 'internal', model: 'internal', displayName: 'Internal', description: '', isDefault: false, hidden: true },
          ], nextCursor: null };
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
      case 'turn/interrupt':
        if (this.interruptError !== null) {
          const error = this.interruptError;
          queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, error }));
          return;
        }
        break;
    }
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }

  close(): void {
    this.closes += 1;
  }

  frame(value: unknown): void {
    this.#handlers.onFrame(value);
  }
}

function setup(
  options: Partial<ConstructorParameters<typeof CodexDriver>[0]> = {},
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

async function permissionHarness(overrides: Record<string, unknown> = {}, method = 'item/commandExecution/requestApproval') {
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
    method,
    params: {
      itemId: 'approval-item',
      turnId: 'turn-live',
      command: ['git', 'status'],
      availableDecisions: ['accept', 'cancel', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } }],
      ...overrides,
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

describe('CodexDriver execution policy', () => {
  it('keeps on-request approval and omits sandbox on thread/start by default', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    const start = state.transport.sent.find((frame) => frame.method === 'thread/start');
    expect(start).toMatchObject({ params: { approvalPolicy: 'on-request' } });
    expect(start?.params).not.toHaveProperty('sandbox');
  });

  it('preserves Codex settings by omitting both options on thread/resume by default', async () => {
    const state = setup({ resumeSessionId: 'thread-resumed' });
    state.driver.start();
    await state.driver.ready;
    const resume = state.transport.sent.find((frame) => frame.method === 'thread/resume');
    expect(resume).toMatchObject({ params: { threadId: 'thread-resumed' } });
    expect(resume?.params).not.toHaveProperty('approvalPolicy');
    expect(resume?.params).not.toHaveProperty('sandbox');
  });

  describe.each([
    ['thread/start', {}],
    ['thread/resume', { resumeSessionId: 'thread-resumed' }],
  ] as const)('%s', (method, resumeOptions) => {
    it('sends an approval override without adding a sandbox override', async () => {
      const state = setup({ ...resumeOptions, approvalPolicy: 'never' });
      state.driver.start();
      await state.driver.ready;
      const request = state.transport.sent.find((frame) => frame.method === method);
      expect(request).toMatchObject({ params: { approvalPolicy: 'never' } });
      expect(request?.params).not.toHaveProperty('sandbox');
    });

    it('sends a sandbox override without adding an approval override on resume', async () => {
      const state = setup({ ...resumeOptions, sandbox: 'read-only' });
      state.driver.start();
      await state.driver.ready;
      const request = state.transport.sent.find((frame) => frame.method === method);
      expect(request).toMatchObject({ params: { sandbox: 'read-only' } });
      if (method === 'thread/start') expect(request?.params).toHaveProperty('approvalPolicy', 'on-request');
      else expect(request?.params).not.toHaveProperty('approvalPolicy');
    });

    it('keeps the validated settings when the caller later changes its options object', async () => {
      let transport!: FakeTransport;
      const options: CodexDriverOptions = {
        cwd: 'C:\\work', parentEnv: {}, ...resumeOptions, approvalPolicy: 'untrusted', sandbox: 'read-only',
      };
      const driver = new CodexDriver(options, {}, (_options, handlers) => (transport = new FakeTransport(handlers)));
      Object.assign(options, { approvalPolicy: 'never', sandbox: 'danger-full-access' });
      driver.start();
      await driver.ready;
      expect(transport.sent.find((frame) => frame.method === method))
        .toMatchObject({ params: { approvalPolicy: 'untrusted', sandbox: 'read-only' } });
    });

    it.each([
      ['untrusted', 'read-only'],
      ['on-request', 'workspace-write'],
      ['never', 'danger-full-access'],
    ] as const)('sends approvalPolicy %s and sandbox %s', async (approvalPolicy, sandbox) => {
      const state = setup({ ...resumeOptions, approvalPolicy, sandbox });
      state.driver.start();
      await state.driver.ready;
      expect(state.transport.sent.find((frame) => frame.method === method))
        .toMatchObject({ params: { approvalPolicy, sandbox } });
    });
  });

  describe.each([
    ['approvalPolicy', ['untrusted', 'on-request', 'never']],
    ['sandbox', ['read-only', 'workspace-write', 'danger-full-access']],
  ] as const)('%s validation', (option, allowed) => {
    it.each(['on-failure', '', 'NEVER', 123, false, null, {}, ['never'], new String('never')])(
      'refuses %j at construction before spawning or sending', (value) => {
        const transport = new FakeTransport({
          onFrame: vi.fn(), onStderr: vi.fn(), onProblem: vi.fn(), onExit: vi.fn(),
        });
        const start = vi.spyOn(transport, 'start');
        const factory = vi.fn<CodexTransportFactory>(() => transport);
        const options = { cwd: 'C:\\work', parentEnv: {}, [option]: value } as CodexDriverOptions;
        expect(() => new CodexDriver(options, {}, factory))
          .toThrow(new RegExp(`${option}.*${allowed.join('.*')}`));
        expect(factory).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(transport.sent).toEqual([]);
      },
    );
  });
});

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

  it('sanitizes the approval title and consent reason shown to the client', async () => {
    const state = await permissionHarness({
      command: '\u001b[31mrun tests\u001b[0m',
      reason: '\u001b[32mThis command is allowed\u001b[0m',
    });
    const params = state.permissionRequest.params as Record<string, unknown>;
    const toolCall = params.toolCall as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown>;
    expect(toolCall.title).toBe('run tests');
    expect(meta.reason).toBe('This command is allowed');
    expect(meta.providerTextSanitized).toBe(true);
    state.close();
  });

  it('reports providerTextSanitized when only the approval reason changes', async () => {
    const state = await permissionHarness({
      command: 'run tests',
      reason: '\u001b[32mThis command is allowed\u001b[0m',
    });
    const params = state.permissionRequest.params as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown>;
    expect(meta.reason).toBe('This command is allowed');
    expect(meta.providerTextSanitized).toBe(true);
    state.close();
  });

  it('sanitizes command execution titles while preserving raw command input', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    const command = '\u001b[31mnode test\u001b[0m';
    state.transport.frame({
      jsonrpc: '2.0', method: 'item/started',
      params: { item: { type: 'commandExecution', id: 'command-title', command } },
    });
    expect(state.updates.at(-1)).toMatchObject({
      title: 'node test',
      rawInput: { command },
    });
    state.driver.kill();
  });

  it('sanitizes MCP tool titles but keeps the arguments verbatim', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    const arguments_ = { code: '\u001b[31mvalue\u001b[0m' };
    state.transport.frame({
      jsonrpc: '2.0', method: 'item/started',
      params: {
        item: {
          type: 'mcpToolCall', id: 'mcp-title',
          tool: 'mcp__\u001b[31mterminal\u001b[0m__run', arguments: arguments_,
        },
      },
    });
    expect(state.updates.at(-1)).toMatchObject({
      title: 'mcp__terminal__run',
      rawInput: arguments_,
    });
    state.driver.kill();
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

  it('a refusal reason from the client becomes the legacy rejection text, exactly (tynn, Genie shell limits)', async () => {
    const reason = 'Genie: this workspace already runs 3 of 3 shells (npm run dev, vitest, php artisan queue:work).';
    const state = await permissionHarness({ callId: 'call-1', command: ['rm', '-rf', 'build'], cwd: '/work' }, 'execCommandApproval');
    const result = await state.answer({ outcome: { outcome: 'selected', optionId: 'codex-deny' }, _meta: { [META_PERMISSION_REASON]: reason } });

    expect(result).toMatchObject({ result: { decision: { denied: { rejection: reason } } } });
    state.close();
  });

  it('CONTROL: without a reason the legacy rejection keeps its default text', async () => {
    const state = await permissionHarness({ callId: 'call-1', command: ['rm', '-rf', 'build'], cwd: '/work' }, 'execCommandApproval');
    const result = await state.answer({ outcome: { outcome: 'selected', optionId: 'codex-deny' }, _meta: { [META_PERMISSION_REASON]: '' } });

    expect(result).toMatchObject({ result: { decision: { denied: { rejection: 'Declined by user' } } } });
    state.close();
  });

  it('a reason never turns a refusal into an allow, and a v2 decline (which carries no text) is unchanged by one', async () => {
    const state = await permissionHarness({ availableDecisions: ['accept', 'decline'] });
    const result = await state.answer({ outcome: { outcome: 'selected', optionId: 'codex-decline' }, _meta: { [META_PERMISSION_REASON]: 'a limit' } });

    expect(result).toMatchObject({ result: { decision: 'decline' } });
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

/**
 * Turn cancel (issue #16). The documented request is app-server `turn/interrupt` with `{ threadId, turnId }`; its
 * success is `{}` and "the turn finishes with status: \"interrupted\"" (https://learn.chatgpt.com/docs/app-server,
 * "Interrupt a turn"). The process and the thread must survive it: Stop ends a turn, not a session.
 */
describe('CodexDriver turn cancel', () => {
  const interrupts = (transport: FakeTransport) => transport.sent.filter((frame) => frame.method === 'turn/interrupt');
  const turnStarts = (transport: FakeTransport) => transport.sent.filter((frame) => frame.method === 'turn/start');

  it('declares cancel, so a client can label Stop as ending the turn', () => {
    expect(CODEX_DRIVER_CAPABILITIES.cancel).toBe(true);
  });

  it('sends the documented turn/interrupt frame, ends the turn cancelled, and keeps the app-server alive', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await settle();

    await state.driver.cancel();

    expect(interrupts(state.transport)).toEqual([
      {
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'turn/interrupt',
        params: { threadId: 'thread-captured', turnId: 'turn-live' },
      },
    ]);
    // The interrupt is a REQUEST to stop; the turn ends when Codex says it did.
    expect(state.turnEnds).toEqual([]);
    state.transport.frame({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turn: { id: 'turn-live', status: 'interrupted' } },
    });
    expect(state.turnEnds).toEqual([{ stopReason: 'cancelled', isError: false, raw: 'interrupted' }]);
    expect(state.transport.closes).toBe(0);

    // The session is still promptable: the next prompt starts a NEW turn on the same thread.
    state.driver.prompt('again');
    await settle();
    expect(turnStarts(state.transport)).toHaveLength(2);
    expect(turnStarts(state.transport)[1]?.params).toMatchObject({ threadId: 'thread-captured' });
    expect(state.transport.closes).toBe(0);
    state.driver.kill();
  });

  it('waits for the turn id when cancel arrives before turn/start has answered', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    // turn/start has been sent but not answered: there is no turn id to interrupt yet.
    const cancelled = state.driver.cancel();
    expect(interrupts(state.transport)).toEqual([]);
    await settle();
    await cancelled;

    expect(interrupts(state.transport)).toHaveLength(1);
    expect(interrupts(state.transport)[0]?.params).toEqual({ threadId: 'thread-captured', turnId: 'turn-live' });
    expect(state.transport.closes).toBe(0);
    state.driver.kill();
  });

  it('ends a prompt still queued behind startup as cancelled without ever starting it', async () => {
    const state = setup();
    state.driver.start();
    // Before ready: the prompt is queued, nothing has reached Codex.
    state.driver.prompt('go');
    await state.driver.cancel();
    await state.driver.ready;
    await settle();

    expect(turnStarts(state.transport)).toEqual([]);
    expect(interrupts(state.transport)).toEqual([]);
    expect(state.turnEnds).toEqual([{ stopReason: 'cancelled', isError: false, raw: 'cancelled before start' }]);
    expect(state.transport.closes).toBe(0);

    state.driver.prompt('next');
    await settle();
    expect(turnStarts(state.transport)).toHaveLength(1);
    state.driver.kill();
  });

  it('is a no-op with no turn running: nothing on the wire, nothing killed', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    const before = state.transport.sent.length;

    await state.driver.cancel();

    expect(state.transport.sent.length).toBe(before);
    expect(state.turnEnds).toEqual([]);
    expect(state.transport.closes).toBe(0);
    state.driver.kill();
  });

  it('rejects when Codex refuses the interrupt, and the turn is left to finish on its own terms', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('go');
    await settle();
    state.transport.interruptError = { code: -32600, message: 'no active turn' };

    await expect(state.driver.cancel()).rejects.toThrow(/turn\/interrupt/);
    expect(state.turnEnds).toEqual([]);
    expect(state.transport.closes).toBe(0);
    state.driver.kill();
  });

  it('session/cancel over the ACP wire interrupts the turn instead of killing the app-server', async () => {
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
    const sessionId = (outputFrames.find((frame) => frame.id === 2)?.result as Record<string, unknown>).sessionId;

    input.write(encodeLine({
      jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    }));
    await settle();
    input.write(encodeLine({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));
    await settle();

    expect(interrupts(transport)).toHaveLength(1);
    expect(transport.closes).toBe(0);
    transport.frame({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-live', status: 'interrupted' } } });
    await settle();
    expect(outputFrames.find((frame) => frame.id === 3)?.result).toEqual({ stopReason: 'cancelled' });

    // Same session, same process, a new turn.
    input.write(encodeLine({
      jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'again' }] },
    }));
    await settle();
    expect(turnStarts(transport)).toHaveLength(2);
    transport.frame({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-live-2', status: 'completed' } } });
    await settle();
    expect(outputFrames.find((frame) => frame.id === 4)?.result).toEqual({ stopReason: 'end_turn' });
    expect(transport.closes).toBe(0);
    expect(agent.sessionIds).toEqual([sessionId]);

    // Control: closing the connection still kills the app-server.
    const inputClosed = new Promise<void>((resolve) => input.once('close', () => resolve()));
    input.destroy();
    await inputClosed;
    expect(transport.closes).toBe(1);
  });
});

/**
 * MCP TOOL APPROVAL (Genie, 2026-10-17: every Codex agent's call to Genie's own MCP tools came back "user rejected MCP
 * tool call" and the person was never asked). Before an MCP tool call Codex sends `mcpServer/elicitation/request`
 * (codex-cli 0.156.1 `app-server generate-json-schema`: params { serverName, threadId, turnId, mode, message,
 * requestedSchema | url }, answered { action: accept | decline | cancel, content? }). This driver answered it with
 * -32601 "method not supported", which Codex reads as the user's refusal — silently.
 *  - `mcpToolApproval` sets Codex's documented `mcp_servers.<id>.default_tools_approval_mode` per server, so a client
 *    can pre-approve a server it trusts (its own) and Codex never asks.
 *  - An elicitation this driver cannot answer is SAID, as a recoverable problem naming the server and Codex's question,
 *    and declined explicitly — never a silent no.
 */
describe('CodexDriver MCP tool approval', () => {
  const genie = { type: 'http' as const, name: 'genie', url: 'http://127.0.0.1:40123/mcp', headers: [] };
  const other = { type: 'http' as const, name: 'other', url: 'http://127.0.0.1:40124/mcp', headers: [] };

  it('puts default_tools_approval_mode on the named server only, on thread/start', async () => {
    const state = setup({ mcpServers: [genie, other], mcpToolApproval: { genie: 'approve' } });
    state.driver.start();
    await state.driver.ready;
    const start = state.transport.sent.find((f) => f.method === 'thread/start');
    const servers = (start?.params as { config: { mcp_servers: Record<string, Record<string, unknown>> } }).config.mcp_servers;
    expect(servers.genie).toMatchObject({ url: genie.url, default_tools_approval_mode: 'approve' });
    expect(servers.other).not.toHaveProperty('default_tools_approval_mode'); // CONTROL: only the server named
  });

  it('and on thread/resume', async () => {
    const state = setup({ resumeSessionId: 'thread-resumed', mcpServers: [genie], mcpToolApproval: { genie: 'approve' } });
    state.driver.start();
    await state.driver.ready;
    const resume = state.transport.sent.find((f) => f.method === 'thread/resume');
    expect((resume?.params as { config: { mcp_servers: Record<string, Record<string, unknown>> } }).config.mcp_servers.genie)
      .toMatchObject({ default_tools_approval_mode: 'approve' });
  });

  it('refuses an approval for a server it was not given, or a mode Codex does not document', () => {
    expect(() => setup({ mcpServers: [genie], mcpToolApproval: { nope: 'approve' } })).toThrow(/nope/);
    expect(() => setup({ mcpServers: [genie], mcpToolApproval: { genie: 'always' as never } })).toThrow(/always/);
  });

  it('an MCP elicitation it cannot answer is SAID (recoverable, naming server and question) and declined explicitly', async () => {
    const problems: Array<{ problem: string; detail: unknown }> = [];
    const state = setup({ mcpServers: [genie] }, { onProtocolError: (problem, detail) => problems.push({ problem, detail }) });
    state.driver.start();
    await state.driver.ready;
    state.transport.frame({
      jsonrpc: '2.0', id: 77, method: 'mcpServer/elicitation/request',
      params: { serverName: 'genie', threadId: 'thread-captured', turnId: null, mode: 'form', message: 'Allow the agentinbox tool?', requestedSchema: { type: 'object', properties: {} } },
    });
    await settle();
    const reply = state.transport.sent.find((f) => f.id === 77);
    expect(reply).toEqual({ jsonrpc: '2.0', id: 77, result: { action: 'decline' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain('genie');
    expect(problems[0]!.problem).toContain('Allow the agentinbox tool?');
    expect(problems[0]!.detail).toEqual({ recoverable: true });
  });

  it('CONTROL: another unknown server request still gets -32601', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.transport.frame({ jsonrpc: '2.0', id: 78, method: 'something/else', params: {} });
    await settle();
    expect(state.transport.sent.find((f) => f.id === 78)).toMatchObject({ error: { code: -32601 } });
  });
});

/**
 * THE MODEL PICKER SHOWS WHAT CODEX OFFERS (tynn, for the owner, 2026-10-21). `model/list` is the app-server's own
 * method (its schema: ModelListParams -> ModelListResponse { data, nextCursor }); measured with
 * scripts/probe-codex-models.mjs on codex-cli 0.163.0. A switch has no call of its own: turn/start's `model` applies to
 * that turn and every later one.
 */
describe('CodexDriver models', () => {
  const turnStartsOf = (transport: FakeTransport) => transport.sent.filter((frame) => frame.method === 'turn/start');

  it('lists every page of model/list, without hidden models, with the default current', async () => {
    const state = setup();
    state.driver.start();
    const models = await state.driver.modelState();
    expect(models.availableModels.map((m) => m.modelId)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(models.currentModelId).toBe('gpt-6.1-sol');
    expect(state.transport.sent.filter((f) => f.method === 'model/list').map((f) => (f.params as Record<string, unknown>).cursor))
      .toEqual([null, 'models-2']);
    state.driver.kill();
  });

  it('a switch is sent with the next turn/start, and only from then on', async () => {
    const state = setup();
    state.driver.start();
    await state.driver.ready;
    state.driver.prompt('first');
    await settle();
    expect(turnStartsOf(state.transport)[0]?.params).not.toHaveProperty('model');
    state.transport.frame({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-live', status: 'completed' } } });
    await settle();

    await state.driver.setModel('gpt-6-luna');
    expect((await state.driver.modelState()).currentModelId).toBe('gpt-6-luna');
    state.driver.prompt('second');
    await settle();
    expect(turnStartsOf(state.transport)[1]?.params).toMatchObject({ model: 'gpt-6-luna' });
    await expect(state.driver.setModel('--flag')).rejects.toThrow(/refusing model/);
    state.driver.kill();
  });
});
