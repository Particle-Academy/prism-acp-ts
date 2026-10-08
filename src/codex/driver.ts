import { childEnv } from '../env.js';
import { JsonRpcPeer } from '../jsonrpc.js';
import {
  META_CLI_SESSION_ID,
  META_EXEC_POLICY_AMENDMENT,
  META_RATE_LIMIT,
  META_UNMAPPED_FRAME,
  withMeta,
} from '../meta.js';
import type {
  AgentDriver,
  DriverEvents,
  PermissionOutcome,
  PermissionRequest,
} from '../acp/agent.js';
import type { AcpUpdate } from '../claude/to-acp.js';
import type { TurnOutcome } from '../claude/driver.js';
import {
  codexRateLimitNotice,
  readCodexRateLimit,
} from './rate-limit.js';
import {
  StdioCodexTransport,
  type CodexTransport,
  type CodexTransportHandlers,
  type CodexTransportOptions,
} from './transport.js';

export interface CodexDriverOptions {
  readonly cwd: string;
  /** Trusted configuration; must not be built from untrusted input. */
  readonly binary?: string;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  readonly allowEnv?: readonly string[];
  readonly resumeSessionId?: string;
  readonly turnInactivityTimeoutMs?: number;
}

export type CodexTransportFactory = (
  options: CodexTransportOptions,
  handlers: CodexTransportHandlers,
) => CodexTransport;

interface Choice {
  readonly option: Record<string, unknown>;
  readonly decision: unknown;
}

interface PendingApproval {
  readonly cancel: () => void;
}

const DEFAULT_TRANSPORT_FACTORY: CodexTransportFactory = (options, handlers) =>
  new StdioCodexTransport(options, handlers);

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);
const MAX_HISTORY_PAGES = 10_000;
const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS = 600_000;

const KNOWN_NOTIFICATIONS = new Set([
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'turn/plan/updated',
  'turn/plan/delta',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'contextCompacted',
  'thread/compaction/started',
  'collabAgentSpawnBegin',
  'collabAgentSpawnEnd',
  'collabAgentMessage',
  'collabAgentToolCall',
  'collabAgentToolResult',
]);

/**
 * Codex App Server driver. The App Server owns the durable thread identity;
 * this driver only captures it from thread/start or thread/resume.
 */
export class CodexDriver implements AgentDriver {
  readonly #options: CodexDriverOptions;
  readonly #events: DriverEvents;
  readonly #transportFactory: CodexTransportFactory;
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #completedTurns = new Set<string>();
  readonly #items = new Map<string, Record<string, unknown>>();
  readonly #activeItemIds = new Set<string>();
  readonly #messageDeltas = new Set<string>();
  readonly #reasoningDeltas = new Set<string>();
  #itemSequence = 0;
  #approvalSequence = 0;
  #transport: CodexTransport | null = null;
  #peer: JsonRpcPeer | null = null;
  #started = false;
  #closed = false;
  #ready: Promise<void> = Promise.resolve();
  #queuedPrompt: string | null = null;
  #activeTurn: string | null = null;
  #turnInFlight = false;
  #turnDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  #turnDeadlineExpiresAt = 0;
  #turnDeadlineRemainingMs = 0;
  readonly #turnInactivityTimeoutMs: number;
  #sessionUpdateSent = false;
  #threadId: string | null = null;

  withheldCredentials: readonly string[] = [];
  cliSessionId: string | null = null;

  constructor(
    options: CodexDriverOptions,
    events: DriverEvents = {},
    transportFactory: CodexTransportFactory = DEFAULT_TRANSPORT_FACTORY,
  ) {
    this.#options = options;
    this.#events = events;
    this.#transportFactory = transportFactory;
    this.#turnInactivityTimeoutMs = options.turnInactivityTimeoutMs ?? DEFAULT_TURN_INACTIVITY_TIMEOUT_MS;
    if (!Number.isFinite(this.#turnInactivityTimeoutMs) || this.#turnInactivityTimeoutMs <= 0) {
      throw new Error('turnInactivityTimeoutMs must be a positive finite number');
    }
  }

  /** Resolves once initialize and thread start/resume have completed. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  start(): void {
    if (this.#started) throw new Error('driver already started');
    this.#started = true;

    if (this.#options.resumeSessionId !== undefined && isMintedAcpId(this.#options.resumeSessionId)) {
      this.#events.onProtocolError?.(
        `refusing an ACP-minted session id; resume with the Codex id carried as ${META_CLI_SESSION_ID}`,
      );
      this.#events.onExit?.(1, null);
      return;
    }

    this.#ready = this.#connect().catch((cause: unknown) => {
      this.#events.onProtocolError?.(safeError('Codex app-server startup failed', cause));
      this.#finishTurn({ stopReason: null, isError: true, raw: 'app-server startup failed' });
      this.#shutdown('SIGTERM');
    });
  }

  prompt(text: string): void {
    if (!this.#started || this.#closed) throw new Error('driver is not started, or has exited');
    if (this.#turnInFlight || this.#queuedPrompt !== null) throw new Error('Codex turn already in flight');
    this.#turnInFlight = true;
    if (this.#peer === null || this.#threadId === null) {
      this.#queuedPrompt = text;
      return;
    }
    this.#startTurn(text);
  }

  /** App Server has no stdin close operation; the thread remains promptable. */
  endInput(): void {}

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.#shutdown(signal);
  }

  async #connect(): Promise<void> {
    const { env, withheld } = childEnv(this.#options.parentEnv ?? process.env, {
      allow: ['CODEX_HOME', 'CODEX_CONFIG_DIR', 'XDG_CONFIG_HOME', ...(this.#options.allowEnv ?? [])],
    });
    this.withheldCredentials = withheld;

    const handlers: CodexTransportHandlers = {
      onFrame: (frame) => this.#receive(frame),
      onStderr: (line) => this.#events.onStderr?.(line),
      onProblem: (problem) => this.#events.onProtocolError?.(problem),
      onExit: (code, signal) => this.#onExit(code, signal),
    };
    const transport = this.#transportFactory(
      { cwd: this.#options.cwd, env, ...(this.#options.binary === undefined ? {} : { binary: this.#options.binary }) },
      handlers,
    );
    this.#transport = transport;
    this.#peer = new JsonRpcPeer({
      send: (message) => transport.send(message),
      onProtocolError: (problem, frame) => this.#recordUnmapped(problem, frame),
    });

    await transport.start();
    const peer = this.#requirePeer();
    await peer.request('initialize', {
      clientInfo: { name: '@particle-academy/prism-acp', version: '0.4.1' },
      capabilities: {},
    });
    peer.notify('initialized');

    if (this.#options.resumeSessionId === undefined) {
      const result = await peer.request('thread/start', {
        cwd: this.#options.cwd,
        approvalPolicy: 'on-request',
      });
      const thread = asObject(asObject(result)?.thread);
      const id = asString(thread?.id);
      if (id === undefined || id.length === 0) throw new Error('thread/start response did not contain thread.id');
      this.#setThreadId(id);
    } else {
      const result = await peer.request('thread/resume', {
        threadId: this.#options.resumeSessionId,
        cwd: this.#options.cwd,
        excludeTurns: true,
      });
      const thread = asObject(asObject(result)?.thread);
      const id = asString(thread?.id);
      if (id === undefined || id.length === 0 || id !== this.#options.resumeSessionId) {
        throw new Error('thread/resume did not return the requested Codex thread id');
      }
      this.#setThreadId(id);
      await this.#replayHistory();
    }

    await this.#readInitialRateLimit();
    const queued = this.#queuedPrompt;
    this.#queuedPrompt = null;
    if (queued !== null) this.#startTurn(queued);
  }

  async #readInitialRateLimit(): Promise<void> {
    try {
      const result = await this.#requirePeer().request('account/rateLimits/read', {});
      this.#emitRateLimit(result);
    } catch (cause) {
      // Account telemetry is optional; an unavailable read is not a turn error.
      this.#recordUnmapped(safeError('account/rateLimits/read failed', cause), {
        method: 'account/rateLimits/read',
      });
    }
  }

  async #replayHistory(): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null) return;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (seenCursors.size >= MAX_HISTORY_PAGES) {
        this.#recordUnmapped('thread/turns/list exceeded the 10000-page safety limit', { method: 'thread/turns/list' });
        return;
      }
      const response = asObject(
        await this.#requirePeer().request('thread/turns/list', {
          threadId,
          sortDirection: 'asc',
          itemsView: 'none',
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      if (!Array.isArray(response?.data)) {
        this.#recordUnmapped('thread/turns/list response omitted data array', response);
        return;
      }
      const turns = response.data;
      for (const entry of turns) {
        const turn = asObject(entry);
        const turnId = asString(turn?.id);
        if (turnId === undefined) {
          this.#recordUnmapped('thread/turns/list entry omitted id', entry);
          continue;
        }
        await this.#replayTurnItems(turnId);
      }
      cursor = this.#nextCursor(response, 'thread/turns/list', seenCursors);
    } while (cursor !== undefined);
  }

  async #replayTurnItems(turnId: string): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null) return;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (seenCursors.size >= MAX_HISTORY_PAGES) {
        this.#recordUnmapped('thread/items/list exceeded the 10000-page safety limit', {
          method: 'thread/items/list',
        });
        return;
      }
      const response = asObject(
        await this.#requirePeer().request('thread/items/list', {
          threadId,
          turnId,
          sortDirection: 'asc',
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      if (!Array.isArray(response?.data)) {
        this.#recordUnmapped('thread/items/list response omitted data array', response);
        return;
      }
      const entries = response.data;
      for (const entry of entries) {
        const object = asObject(entry);
        if (object === undefined) {
          this.#recordUnmapped('thread/items/list entry was not an object', entry);
          continue;
        }
        this.#mapItem(asObject(object.item) ?? object, true);
      }
      cursor = this.#nextCursor(response, 'thread/items/list', seenCursors);
    } while (cursor !== undefined);
  }

  #nextCursor(response: Record<string, unknown> | undefined, method: string, seen: Set<string>): string | undefined {
    if (response?.nextCursor === undefined || response.nextCursor === null) return undefined;
    if (typeof response.nextCursor === 'string' && response.nextCursor.length > 0) {
      if (seen.has(response.nextCursor)) {
        this.#recordUnmapped(`${method} repeated a page cursor`, { method });
        return undefined;
      }
      seen.add(response.nextCursor);
      return response.nextCursor;
    }
    this.#recordUnmapped(`${method} nextCursor expected a non-empty string or null`, response);
    return undefined;
  }

  #startTurn(text: string): void {
    const threadId = this.#threadId;
    if (threadId === null) {
      this.#queuedPrompt = text;
      return;
    }
    this.#beginTurnDeadline();
    void this.#requirePeer()
      .request('turn/start', {
        threadId,
        cwd: this.#options.cwd,
        input: [{ type: 'text', text }],
      })
      .then((value) => {
        const turn = asObject(asObject(value)?.turn);
        const id = asString(turn?.id);
        if (id !== undefined && !this.#completedTurns.has(id)) {
          this.#activeTurn = id;
          this.#touchTurnDeadline();
        }
      })
      .catch((cause: unknown) => {
        this.#events.onProtocolError?.(safeError('Codex turn/start failed', cause));
        this.#finishTurn({ stopReason: null, isError: true, raw: 'turn/start failed' });
      });
  }

  #receive(raw: unknown): void {
    if (this.#closed) return;
    let frame: unknown = raw;
    if (typeof raw === 'string') {
      try {
        frame = JSON.parse(raw) as unknown;
      } catch {
        this.#recordUnmapped(`malformed Codex JSON frame: string(${raw.length})`, {
          type: 'malformed_json',
          description: `string(${raw.length})`,
        });
        return;
      }
    }
    const object = asObject(frame);
    if (object === undefined) {
      this.#recordUnmapped('Codex frame was not an object', { description: describe(frame) });
      return;
    }

    const method = asString(object.method);
    this.#noteTurnActivity(method, object.params);
    const hasId = typeof object.id === 'number' || typeof object.id === 'string';
    if (method !== undefined && hasId) {
      if (APPROVAL_METHODS.has(method)) {
        void this.#handleApproval(object.id as string | number, method, object.params);
      } else {
        this.#recordUnmapped(`unhandled Codex server request: ${method}`, object);
        this.#sendServerReply({
          jsonrpc: '2.0',
          id: object.id,
          error: { code: -32601, message: `method not supported: ${method}` },
        });
      }
      return;
    }
    if (method !== undefined) {
      this.#handleNotification(method, object.params);
      return;
    }
    void this.#requirePeer().receive(frame);
  }

  #handleNotification(method: string, params: unknown): void {
    const object = asObject(params) ?? {};
    if (!KNOWN_NOTIFICATIONS.has(method)) {
      this.#recordUnmapped(`unmapped Codex notification: ${method}`, { method, params });
      return;
    }
    switch (method) {
      case 'thread/started': {
        const id = asString(asObject(object.thread)?.id);
        if (id !== undefined) this.#setThreadId(id);
        else this.#recordUnmapped('thread/started omitted thread.id', object);
        return;
      }
      case 'thread/status/changed': {
        const status = asObject(object.status);
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
        if (flags.includes('waitingOnApproval')) {
          this.#emit({ sessionUpdate: 'notice', notice: { level: 'info', message: 'Codex is waiting for permission.' } });
        }
        this.#recordUnmapped('thread/status/changed has no other ACP mapping', object);
        return;
      }
      case 'turn/started': {
        const id = asString(asObject(object.turn)?.id);
        if (id !== undefined) {
          this.#activeTurn = id;
          this.#turnInFlight = true;
        } else this.#recordUnmapped('turn/started omitted turn.id', object);
        return;
      }
      case 'turn/completed': {
        const turn = asObject(object.turn) ?? {};
        const id = asString(turn.id) ?? this.#activeTurn;
        const status = asString(turn.status) ?? 'failed';
        if (turn.status === undefined) this.#recordUnmapped('turn/completed omitted status', object);
        else if (!['completed', 'interrupted', 'canceled', 'cancelled', 'failed'].includes(status)) {
          this.#recordUnmapped('turn/completed had an unknown status', object);
        }
        if (id === null || id === undefined) {
          this.#recordUnmapped('turn/completed did not contain a turn id', object);
          return;
        }
        if (status === 'completed') {
          this.#finishTurn({ stopReason: 'end_turn', isError: false, raw: status }, id);
        } else if (status === 'interrupted' || status === 'canceled' || status === 'cancelled') {
          this.#finishTurn({ stopReason: 'cancelled', isError: false, raw: status }, id);
        } else {
          this.#finishTurn({ stopReason: null, isError: true, raw: status }, id);
        }
        return;
      }
      case 'item/started':
      case 'item/completed':
        this.#mapItem(asObject(object.item) ?? {}, false, method === 'item/completed');
        return;
      case 'item/agentMessage/delta':
        {
          const itemId = asString(object.itemId);
          if (itemId !== undefined) {
            this.#messageDeltas.add(itemId);
            this.#activeItemIds.add(itemId);
            this.#pauseTurnDeadline();
          } else this.#recordUnmapped('item/agentMessage/delta omitted itemId', object);
        }
        if (typeof object.delta !== 'string') {
          this.#recordUnmapped('item/agentMessage/delta omitted string delta', object);
          return;
        }
        this.#emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: object.delta },
        });
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        {
          const itemId = asString(object.itemId);
          if (itemId !== undefined) {
            this.#reasoningDeltas.add(itemId);
            this.#activeItemIds.add(itemId);
            this.#pauseTurnDeadline();
          } else this.#recordUnmapped(`${method} omitted itemId`, object);
        }
        if (typeof object.delta !== 'string') {
          this.#recordUnmapped(`${method} omitted string delta`, object);
          return;
        }
        this.#emit({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: object.delta },
        });
        return;
      case 'turn/plan/updated':
        this.#emitPlan(object.plan, 'plan');
        return;
      case 'turn/plan/delta':
        this.#emit({ sessionUpdate: 'plan_update', delta: object.delta ?? object });
        return;
      case 'thread/tokenUsage/updated':
        this.#emitUsage(object.tokenUsage);
        return;
      case 'account/rateLimits/updated':
        this.#emitRateLimit(object.rateLimits);
        return;
      case 'contextCompacted':
      case 'thread/compaction/started':
        this.#emit({ sessionUpdate: 'compaction_update', ...publicFields(object) });
        return;
      default:
        this.#emit({ sessionUpdate: 'subagent_update', ...publicFields(object) });
    }
  }

  #mapItem(item: Record<string, unknown>, replay: boolean, completed = false): void {
    const type = asString(item.type) ?? 'unknown';
    const id = asString(item.id) ?? asString(item.itemId) ?? `codex-${type}-${++this.#itemSequence}`;
    if (!replay) {
      if (completed) {
        this.#activeItemIds.delete(id);
        this.#resumeTurnDeadlineIfReady(true);
      } else {
        this.#activeItemIds.add(id);
        this.#pauseTurnDeadline();
      }
    }
    if (completed && !['completed', 'failed', 'declined', 'canceled', 'cancelled', 'exited', 'interrupted'].includes(asString(item.status) ?? '')) {
      this.#recordUnmapped('completed Codex item had an unknown status', item);
    }
    if (type === 'userMessage') {
      if (replay || completed) {
        const text = textFromContent(item.content);
        if (text.length > 0) this.#emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
        else this.#recordUnmapped('Codex userMessage had no text content', item);
      }
      return;
    }
    if (type === 'agentMessage') {
      if (replay) {
        const text = asString(item.text) ?? '';
        if (text.length > 0) this.#emit({ sessionUpdate: 'session_message', content: [{ type: 'text', text }] });
        else this.#recordUnmapped('replayed agentMessage had no text', item);
      } else if (completed) {
        const hadDeltas = this.#messageDeltas.delete(id);
        const text = asString(item.text) ?? '';
        if (!hadDeltas && text.length > 0) {
          this.#emit({ sessionUpdate: 'session_message', content: [{ type: 'text', text }] });
        } else if (!hadDeltas) {
          this.#recordUnmapped('completed agentMessage had no text or deltas', item);
        }
      }
      return;
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.map(textFromContent).join('') : '';
      if (replay) {
        if (summary.length > 0) this.#emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: summary } });
        else this.#recordUnmapped('replayed reasoning item had no summary', item);
      } else if (completed) {
        const hadDeltas = this.#reasoningDeltas.delete(id);
        if (!hadDeltas && summary.length > 0) {
          this.#emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: summary } });
        } else if (!hadDeltas) {
          this.#recordUnmapped('completed reasoning item had no summary or deltas', item);
        }
      }
      return;
    }

    if (type === 'commandExecution' || type === 'execCommand') {
      const command = asString(item.command) ?? '';
      this.#emit({
        sessionUpdate: completed ? 'tool_call_update' : 'tool_call',
        toolCallId: id,
        title: command.length === 0 ? 'Run command' : command,
        kind: 'execute',
        status: completed ? statusOf(item.status, item.exitCode) : 'pending',
        ...(command.length === 0 ? {} : { rawInput: { command } }),
      });
      if (completed && asString(item.status) === 'declined') {
        this.#finishTurn({ stopReason: 'cancelled', isError: false, raw: 'declined' }, asString(item.turnId));
      }
      return;
    }

    if (type === 'fileChange' || type === 'patchApply') {
      if (!completed) this.#items.set(id, item);
      const changes = item.changes ?? item.fileChanges ?? item.patch;
      if (changes === undefined) this.#recordUnmapped('Codex file-change item omitted changes', item);
      this.#emit({
        sessionUpdate: completed ? 'tool_call_update' : 'tool_call',
        toolCallId: id,
        title: 'Apply file changes',
        kind: 'edit',
        status: completed ? statusOf(item.status) : 'pending',
        ...(changes === undefined ? {} : { rawInput: changes }),
      });
      if (completed && asString(item.status) === 'declined') {
        this.#finishTurn({ stopReason: 'cancelled', isError: false, raw: 'declined' }, asString(item.turnId));
      }
      if (completed) this.#items.delete(id);
      return;
    }

    if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
      this.#emit({
        sessionUpdate: completed ? 'tool_call_update' : 'tool_call',
        toolCallId: id,
        title: asString(item.tool) ?? asString(item.name) ?? 'Tool call',
        status: completed ? statusOf(item.status) : 'pending',
        ...(item.arguments === undefined ? {} : { rawInput: item.arguments }),
      });
      return;
    }

    // Deliberately record both lifecycle points: their payloads differ,
    // because completion adds status and exitCode; unknown types need both.
    // This is useful evidence precisely because the item type is unknown.
    this.#recordUnmapped(`unmapped Codex item: ${type}`, item);
  }

  async #handleApproval(id: string | number, method: string, value: unknown): Promise<void> {
    const params = asObject(value) ?? {};
    const approvalKey = String(id);
    if (this.#pendingApprovals.has(approvalKey)) {
      this.#recordUnmapped('duplicate active Codex approval request id', { method, id });
      // Reuse of an active id is invalid. Cancel and answer the original once;
      // replying separately here would put two responses on the same request id.
      this.#pendingApprovals.get(approvalKey)?.cancel();
      return;
    }

    let settle!: (result: Record<string, unknown> | null) => void;
    let settled = false;
    const resultPromise = new Promise<Record<string, unknown> | null>((resolve) => {
      settle = resolve;
    });
    if (this.#pendingApprovals.size === 0) this.#pauseTurnDeadline();
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      this.#pendingApprovals.delete(approvalKey);
      this.#resumeTurnDeadlineIfReady();
      settle(result);
    };
    this.#pendingApprovals.set(approvalKey, {
      cancel: () => {
        if (settled) return;
        settled = true;
        this.#pendingApprovals.delete(approvalKey);
        this.#resumeTurnDeadlineIfReady();
        try {
          // Send before closing the socket. Resolving a promise here would let
          // shutdown close the transport before the continuation runs.
          this.#transport?.send({ jsonrpc: '2.0', id, result: cancelApprovalResult(method) });
        } catch {
          // The peer is already gone; local settlement still releases ACP.
        }
        settle(null);
      },
    });

    const { request, choices } = this.#permissionRequest(method, params);
    const permissionPromise = this.#events.onRequestPermission?.(request);
    if (permissionPromise === undefined) {
      finish(cancelApprovalResult(method));
    } else {
      void permissionPromise
        .then((outcome) => finish(codexDecision(method, outcome, choices)))
        .catch(() => finish(cancelApprovalResult(method)));
    }

    const result = await resultPromise;
    if (result === null) return;
    try {
      this.#transport?.send({ jsonrpc: '2.0', id, result });
    } catch {
      // Transport death is reported separately and the approval has already
      // been settled locally, so it cannot keep an ACP turn parked.
    }
  }

  #permissionRequest(method: string, params: Record<string, unknown>): {
    request: PermissionRequest;
    choices: Map<string, Choice>;
  } {
    const choices = new Map<string, Choice>();
    const options: Record<string, unknown>[] = [];
    const add = (
      optionId: string,
      name: string,
      kind: string,
      decision: unknown,
      meta?: Record<string, unknown>,
    ) => {
      const option: Record<string, unknown> = { optionId, name, kind };
      if (meta !== undefined) option._meta = meta;
      choices.set(optionId, { option, decision });
      options.push(option);
    };

    let toolCallId = asString(params.itemId) ?? asString(params.callId) ?? asString(params.approvalId) ??
      `codex-permission-${++this.#approvalSequence}`;
    let toolTitle = 'Codex requests permission';
    let rawInput: unknown = undefined;
    let reason = asString(params.reason);

    if (method === 'item/commandExecution/requestApproval') {
      toolTitle = asString(params.command) ?? 'Run command';
      toolCallId = asString(params.itemId) ?? toolCallId;
      rawInput = {
        ...(params.command === undefined ? {} : { command: params.command }),
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.commandActions === undefined ? {} : { commandActions: params.commandActions }),
        ...(params.networkApprovalContext === undefined ? {} : { networkApprovalContext: params.networkApprovalContext }),
        ...(params.proposedNetworkPolicyAmendments === undefined
          ? {}
          : { proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments }),
      };
      const amendment = stringArray(params.proposedExecpolicyAmendment);
      const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
      for (const decision of offered) {
        if (decision === 'accept') add('codex-accept', 'Allow once', 'allow_once', 'accept');
        else if (decision === 'acceptForSession') {
          add('codex-accept-session', 'Allow for this session', 'allow_always', 'acceptForSession');
        } else if (decision === 'cancel') add('codex-cancel', 'Reject', 'reject_once', 'cancel');
        else if (decision === 'decline') add('codex-decline', 'Reject and continue', 'reject_once', 'decline');
        else if (isObject(decision) && isObject(decision.acceptWithExecpolicyAmendment)) {
          const argv = stringArray(
            asObject(decision.acceptWithExecpolicyAmendment)?.execpolicy_amendment,
          ) ?? amendment;
          if (argv !== undefined) {
            add(
              'codex-accept-amendment',
              'Allow and remember this command',
              'allow_always',
              { acceptWithExecpolicyAmendment: { execpolicy_amendment: argv } },
              { [META_EXEC_POLICY_AMENDMENT]: argv },
            );
          } else {
            this.#recordUnmapped('Codex execpolicy amendment omitted its argv', { method, params });
          }
        } else this.#recordUnmapped('unmapped Codex command approval decision', { method, decision });
      }
    } else if (method === 'item/fileChange/requestApproval') {
      const item = this.#items.get(toolCallId);
      toolTitle = 'Apply file changes';
      rawInput = item?.changes ?? item?.fileChanges ?? { grantRoot: params.grantRoot ?? null };
      add('codex-accept', 'Allow once', 'allow_once', 'accept');
      add('codex-accept-session', 'Allow for this session', 'allow_always', 'acceptForSession');
      add('codex-decline', 'Reject', 'reject_once', 'decline');
      add('codex-cancel', 'Cancel request', 'reject_once', 'cancel');
    } else if (method === 'item/permissions/requestApproval') {
      toolTitle = 'Request additional permissions';
      rawInput = params.permissions;
      add('codex-grant-turn', 'Allow for this turn', 'allow_once', { permissions: params.permissions, scope: 'turn' });
      add('codex-grant-session', 'Allow for this session', 'allow_always', {
        permissions: params.permissions,
        scope: 'session',
      });
      add('codex-deny', 'Reject', 'reject_once', { permissions: {}, scope: 'turn' });
    } else {
      const isPatch = method === 'applyPatchApproval';
      toolTitle = isPatch ? 'Apply file changes' : asString(params.command) ?? 'Run command';
      toolCallId = asString(params.callId) ?? toolCallId;
      rawInput = isPatch ? params.fileChanges : { command: params.command, cwd: params.cwd };
      add('codex-approve', 'Allow once', 'allow_once', { decision: 'approved' });
      add('codex-approve-session', 'Allow for this session', 'allow_always', { decision: 'approved_for_session' });
      add('codex-deny', 'Reject and continue', 'reject_once', { decision: { denied: { rejection: 'Declined by user' } } });
      add('codex-abort', 'Cancel this turn', 'reject_once', { decision: 'abort' });
    }

    if (options.length === 0) {
      const fallback = method === 'item/permissions/requestApproval'
        ? { permissions: {}, scope: 'turn' }
        : method === 'applyPatchApproval' || method === 'execCommandApproval'
          ? { decision: 'abort' }
          : 'cancel';
      add('codex-cancel', 'Reject', 'reject_once', fallback);
      this.#recordUnmapped('Codex approval had no recognised available decisions', { method, params });
    }
    const toolCall: Record<string, unknown> = {
      toolCallId,
      title: toolTitle,
      status: 'pending',
      ...(method.includes('commandExecution') || method === 'execCommandApproval'
        ? { kind: 'execute' }
        : method.includes('fileChange') || method === 'applyPatchApproval'
          ? { kind: 'edit' }
          : {}),
      ...(rawInput === undefined ? {} : { rawInput }),
    };
    const request: PermissionRequest = {
      toolCall,
      options,
      _meta: { 'particle.academy/codex_permission_method': method, ...(reason === undefined ? {} : { reason }) },
    };
    return { request, choices };
  }

  #emitRateLimit(value: unknown): void {
    const read = readCodexRateLimit(value);
    if (!read.ok) {
      this.#recordUnmapped(read.reason, { method: 'account/rateLimits' });
      return;
    }
    this.#emit(
      withMeta(
        {
          sessionUpdate: 'notice',
          notice: {
            level: read.limit.ordinaryUsageAllowed === false ? 'warning' : 'info',
            message: codexRateLimitNotice(read.limit),
          },
        },
        { [META_RATE_LIMIT]: read.limit },
      ),
    );
  }

  #emitUsage(value: unknown): void {
    const usage = asObject(value);
    const total = asObject(usage?.total);
    if (total === undefined) {
      this.#recordUnmapped('thread/tokenUsage/updated omitted total', value);
      return;
    }
    if (!isNonNegativeInt(total.inputTokens)) {
      this.#recordUnmapped('thread/tokenUsage/updated total.inputTokens expected a non-negative integer', value);
      return;
    }
    if (!isNonNegativeInt(total.outputTokens)) {
      this.#recordUnmapped('thread/tokenUsage/updated total.outputTokens expected a non-negative integer', value);
      return;
    }
    if (!Number.isSafeInteger(total.inputTokens + total.outputTokens)) {
      this.#recordUnmapped('thread/tokenUsage/updated total token sum exceeds a safe integer', value);
      return;
    }
    for (const field of ['cachedInputTokens', 'reasoningOutputTokens'] as const) {
      if (total[field] !== undefined && total[field] !== null && !isNonNegativeInt(total[field])) {
        this.#recordUnmapped(`thread/tokenUsage/updated total.${field} expected a non-negative integer or null`, value);
        return;
      }
    }
    const contextWindow = typeof usage?.modelContextWindow === 'number' ? usage.modelContextWindow : undefined;
    if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      this.#recordUnmapped('thread/tokenUsage/updated modelContextWindow expected a positive safe integer', value);
      return;
    }
    this.#emit({
      sessionUpdate: 'usage_update',
      used: total.inputTokens + total.outputTokens,
      size: contextWindow,
      _meta: {
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cachedInputTokens: total.cachedInputTokens ?? null,
        reasoningOutputTokens: total.reasoningOutputTokens ?? null,
      },
    });
  }

  #emitPlan(value: unknown, sessionUpdate: string): void {
    if (!Array.isArray(value)) {
      this.#recordUnmapped('turn/plan/updated omitted plan array', value);
      return;
    }
    const entries = value.map((entry, index) => {
      const object = asObject(entry) ?? {};
      const status = asString(object.status);
      if (status !== 'completed' && status !== 'inProgress' && status !== 'pending') {
        this.#recordUnmapped('turn/plan/updated entry had an unknown status', entry);
      }
      return {
        content: asString(object.step) ?? asString(object.title) ?? `Step ${index + 1}`,
        status: status === 'completed' ? 'completed' : status === 'inProgress' ? 'in_progress' : 'pending',
      };
    });
    this.#emit({ sessionUpdate, entries });
  }

  #setThreadId(id: string): void {
    if (id.length === 0) {
      this.#recordUnmapped('Codex thread id was empty', { thread: { id } });
      return;
    }
    if (this.#threadId !== null && this.#threadId !== id) {
      this.#recordUnmapped('Codex thread id changed during a session', { previous: this.#threadId, current: id });
      return;
    }
    this.#threadId = id;
    this.cliSessionId = id;
    if (this.#sessionUpdateSent) return;
    this.#sessionUpdateSent = true;
    this.#emit(
      withMeta(
        { sessionUpdate: 'notice', notice: { level: 'debug', message: 'Codex session started' } },
        { [META_CLI_SESSION_ID]: id },
      ),
    );
  }

  #recordUnmapped(reason: string, frame: unknown): void {
    const safeFrame = stripPrivateIdentifiers(frame);
    this.#emit(
      withMeta(
        { sessionUpdate: 'notice', notice: { level: 'debug', message: reason } },
        { [META_UNMAPPED_FRAME]: { reason, frame: safeFrame } },
      ),
    );
  }

  #emit(update: AcpUpdate): void {
    if (this.#closed) return;
    this.#events.onUpdate?.(update);
  }

  #sendServerReply(frame: Record<string, unknown>): void {
    try {
      this.#transport?.send(frame);
    } catch {
      this.#events.onProtocolError?.('could not answer Codex server request (transport unavailable)');
    }
  }

  #finishTurn(outcome: TurnOutcome, turnId = this.#activeTurn): void {
    if (turnId !== null && this.#completedTurns.has(turnId)) return;
    if (turnId !== null) {
      this.#completedTurns.add(turnId);
      if (this.#completedTurns.size > 64) {
        const oldest = this.#completedTurns.values().next().value as string | undefined;
        if (oldest !== undefined) this.#completedTurns.delete(oldest);
      }
    }
    if (!this.#turnInFlight && this.#activeTurn === null) return;
    this.#clearTurnDeadline();
    this.#activeTurn = null;
    this.#turnInFlight = false;
    this.#items.clear();
    this.#activeItemIds.clear();
    this.#messageDeltas.clear();
    this.#reasoningDeltas.clear();
    this.#events.onTurnEnd?.(outcome);
  }

  #shutdown(signal: NodeJS.Signals): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTurnDeadline();
    for (const pending of [...this.#pendingApprovals.values()]) pending.cancel();
    this.#transport?.close(signal);
    this.#peer?.fail(new Error('Codex driver stopped'));
    this.#events.onExit?.(null, signal);
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTurnDeadline();
    for (const pending of [...this.#pendingApprovals.values()]) pending.cancel();
    this.#peer?.fail(new Error('Codex app-server exited'));
    this.#events.onExit?.(code, signal);
  }

  #requirePeer(): JsonRpcPeer {
    if (this.#peer === null) throw new Error('Codex App Server has not started');
    return this.#peer;
  }

  #noteTurnActivity(method: string | undefined, value: unknown): void {
    if (!this.#turnInFlight) return;
    const params = asObject(value) ?? {};
    const item = asObject(params.item);
    const turn = asObject(params.turn);
    const turnId = asString(params.turnId) ?? asString(item?.turnId) ?? asString(turn?.id);
    if (turnId !== undefined) {
      if (this.#activeTurn === null || turnId === this.#activeTurn) this.#touchTurnDeadline();
      return;
    }
    if (method === 'thread/status/changed' || method?.startsWith('turn/') || method?.startsWith('item/')) {
      this.#touchTurnDeadline();
    }
  }

  #beginTurnDeadline(): void {
    this.#turnDeadlineRemainingMs = this.#turnInactivityTimeoutMs;
    this.#scheduleTurnDeadline();
  }

  #touchTurnDeadline(): void {
    if (!this.#turnInFlight || this.#hasOutstandingWork()) return;
    this.#turnDeadlineRemainingMs = this.#turnInactivityTimeoutMs;
    this.#scheduleTurnDeadline();
  }

  #pauseTurnDeadline(): void {
    if (this.#turnDeadlineTimer === null) return;
    this.#turnDeadlineRemainingMs = Math.max(0, this.#turnDeadlineExpiresAt - Date.now());
    clearTimeout(this.#turnDeadlineTimer);
    this.#turnDeadlineTimer = null;
  }

  #resumeTurnDeadlineIfReady(resetRemaining = false): void {
    if (!this.#turnInFlight || this.#hasOutstandingWork()) return;
    if (resetRemaining) this.#turnDeadlineRemainingMs = this.#turnInactivityTimeoutMs;
    this.#scheduleTurnDeadline();
  }

  #scheduleTurnDeadline(): void {
    if (!this.#turnInFlight || this.#hasOutstandingWork() || this.#closed) return;
    if (this.#turnDeadlineTimer !== null) clearTimeout(this.#turnDeadlineTimer);
    const delay = this.#turnDeadlineRemainingMs;
    this.#turnDeadlineExpiresAt = Date.now() + delay;
    this.#turnDeadlineTimer = setTimeout(() => {
      this.#turnDeadlineTimer = null;
      if (!this.#turnInFlight || this.#hasOutstandingWork()) return;
      const message = `Codex turn inactivity deadline expired after ${this.#turnInactivityTimeoutMs} ms.`;
      this.#emit({ sessionUpdate: 'notice', notice: { level: 'warning', message } });
      this.#recordUnmapped('Codex turn deadline expired', {
        method: 'turn deadline',
        timeoutMs: this.#turnInactivityTimeoutMs,
      });
      this.#finishTurn({ stopReason: null, isError: true, raw: 'turn deadline' });
    }, delay);
  }

  #clearTurnDeadline(): void {
    if (this.#turnDeadlineTimer !== null) clearTimeout(this.#turnDeadlineTimer);
    this.#turnDeadlineTimer = null;
    this.#turnDeadlineRemainingMs = 0;
    this.#turnDeadlineExpiresAt = 0;
  }

  #hasOutstandingWork(): boolean {
    // If this driver adds client-served fs/* or terminal/* calls, their in-flight
    // ACP requests belong here too; a slow client tool is outstanding work.
    return this.#pendingApprovals.size > 0 || this.#activeItemIds.size > 0;
  }
}

function codexDecision(method: string, outcome: PermissionOutcome, choices: Map<string, Choice>): Record<string, unknown> {
  if (outcome.outcome !== 'selected') return cancelApprovalResult(method);
  const choice = choices.get(outcome.optionId);
  if (choice === undefined) return cancelApprovalResult(method);
  if (method === 'item/permissions/requestApproval') {
    return isObject(choice.decision) ? choice.decision : { permissions: {}, scope: 'turn' };
  }
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return isObject(choice.decision) && 'decision' in choice.decision
      ? { decision: choice.decision.decision }
      : { decision: choice.decision };
  }
  return { decision: choice.decision };
}

function cancelApprovalResult(method: string): Record<string, unknown> {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: 'abort' };
  return { decision: 'cancel' };
}

function isMintedAcpId(id: string): boolean {
  return /^sess_\d+_\d+$/.test(id);
}

function safeError(prefix: string, cause: unknown): string {
  if (cause !== null && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    return `${prefix} (RPC code ${typeof code === 'number' ? code : 'unknown'})`;
  }
  return `${prefix} (${cause instanceof Error ? cause.name : typeof cause})`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return asObject(value) !== undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return value as string[];
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => {
      const object = asObject(entry);
      return asString(object?.text) ?? '';
    })
    .join('');
}

function statusOf(status: unknown, exitCode?: unknown): string {
  if (status === 'completed' || (status === 'exited' && exitCode === 0)) return 'completed';
  if (status === 'failed' || status === 'declined' || (typeof exitCode === 'number' && exitCode !== 0)) {
    return 'failed';
  }
  return 'in_progress';
}

function publicFields(value: Record<string, unknown>): Record<string, unknown> {
  return stripPrivateIdentifiers(value) as Record<string, unknown>;
}

function stripPrivateIdentifiers(value: unknown, sensitiveContext = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripPrivateIdentifiers(entry, sensitiveContext));
  const object = asObject(value);
  if (object === undefined) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (
      /(?:account|credit|ratelimit|limit).*id$/.test(normalized) ||
      (sensitiveContext && normalized === 'id')
    ) {
      continue;
    }
    const childSensitive =
      sensitiveContext ||
      normalized === 'account' ||
      normalized === 'ratelimit' ||
      normalized === 'ratelimits' ||
      normalized === 'limit' ||
      normalized === 'ratelimitresetcredits' ||
      normalized === 'credit' ||
      normalized === 'credits';
    result[key] = stripPrivateIdentifiers(entry, childSensitive);
  }
  return result;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value === 'object' ? 'object' : typeof value;
}
