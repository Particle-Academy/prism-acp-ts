/**
 * A bidirectional JSON-RPC 2.0 peer.
 *
 * ACP is symmetric in a way that matters: the client calls `session/prompt` on
 * the agent, and the agent calls `fs/read_text_file` and `terminal/create` back
 * on the client. Both sides send requests and both sides answer them, so this
 * is a peer rather than a client or a server.
 *
 * Transport-agnostic on purpose -- it takes a `send` callback and is fed parsed
 * frames. The framing lives in `ndjson.ts` and the process lives in a driver,
 * so the three can be tested apart. A peer that owned its own pipe could only
 * be tested by spawning something.
 *
 * ## Four decisions, each one pinned because the alternative hangs
 *
 * These were agreed with Genie's implementation so two independent ACP
 * implementations fail the same way rather than differently.
 *
 * **An inbound request with no handler gets a JSON-RPC error, never silence.**
 * This is the one that matters most. A peer waiting on a response it will never
 * receive does not fail -- it parks, forever, looking exactly like an agent
 * that is thinking. An error is the only safe default for a method we do not
 * implement, and the spec does not say so.
 *
 * **A handler that throws still produces a response.** Same reasoning: an
 * exception escaping a handler would otherwise be indistinguishable, from the
 * far side, from a request that was never received.
 *
 * **Transport death rejects EVERY in-flight request.** Otherwise each pending
 * promise hangs for the lifetime of the process and the failure surfaces as a
 * mystery rather than as a dead child.
 *
 * **Correlation is strictly by id, with no ordering assumption.** Nothing in
 * the spec promises responses arrive in request order, so nothing here depends
 * on it.
 */

/** Standard JSON-RPC 2.0 error codes, plus the two this peer raises itself. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export type RpcId = number | string;

/** An error a handler can reject with to control the code the peer sends. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export interface JsonRpcPeerOptions {
  /** Hand one outbound message to the transport. */
  readonly send: (message: unknown) => void;
  /**
   * Called for a frame this peer cannot act on -- a response to an id it never
   * sent, or a message that is not valid JSON-RPC.
   *
   * Surfaced rather than ignored. A transport quietly discarding frames is
   * indistinguishable from one receiving nothing, and that is the failure this
   * whole package is built to stop happening.
   */
  readonly onProtocolError?: (problem: string, frame: unknown) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly method: string;
}

export class JsonRpcPeer {
  readonly #send: (message: unknown) => void;
  readonly #onProtocolError: (problem: string, frame: unknown) => void;
  readonly #requests = new Map<string, RequestHandler>();
  readonly #notifications = new Map<string, NotificationHandler>();
  readonly #pending = new Map<string, Pending>();
  #nextId = 1;
  #failure: Error | null = null;

  constructor(options: JsonRpcPeerOptions) {
    this.#send = options.send;
    this.#onProtocolError = options.onProtocolError ?? (() => {});
  }

  /** Register a handler for an inbound request. */
  handle(method: string, handler: RequestHandler): this {
    this.#requests.set(method, handler);
    return this;
  }

  /** Register a handler for an inbound notification. */
  onNotify(method: string, handler: NotificationHandler): this {
    this.#notifications.set(method, handler);
    return this;
  }

  /** True once {@link fail} has been called. */
  get failed(): boolean {
    return this.#failure !== null;
  }

  /** How many outbound requests are awaiting a response. */
  get inFlight(): number {
    return this.#pending.size;
  }

  /** Send a request and resolve with its result. */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#failure !== null) throw this.#failure;

    const id = this.#nextId++;
    const key = String(id);

    return await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(key, { resolve, reject, method });
      try {
        this.#send(payload(method, params, id));
      } catch (cause) {
        // A transport that refuses the write must not leave the caller waiting
        // on a request that was never sent.
        this.#pending.delete(key);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  /** Send a notification. No response is expected or awaited. */
  notify(method: string, params?: unknown): void {
    if (this.#failure !== null) throw this.#failure;
    this.#send(payload(method, params, undefined));
  }

  /**
   * Feed one inbound frame, already parsed from the wire.
   *
   * Returns a promise only so a caller can await handler completion in a test;
   * production callers may ignore it, because every path responds on its own.
   */
  async receive(frame: unknown): Promise<void> {
    if (!isObject(frame)) {
      this.#onProtocolError('frame is not a JSON-RPC object', frame);
      return;
    }

    const hasId = 'id' in frame && (typeof frame.id === 'number' || typeof frame.id === 'string');
    const hasMethod = typeof frame.method === 'string';

    if (hasMethod && hasId) return await this.#onRequest(frame.method as string, frame);
    if (hasMethod) return this.#onNotification(frame.method as string, frame);
    if (hasId) return this.#onResponse(frame);

    this.#onProtocolError('frame has neither a method nor an id', frame);
  }

  /**
   * Abandon the peer: reject every in-flight request and refuse new ones.
   *
   * Called when the transport dies -- the child exited, the pipe closed. Every
   * pending promise is rejected with the SAME reason, which is what makes a
   * dead child look like a dead child at each call site rather than like a slow
   * one.
   */
  fail(reason: Error): void {
    if (this.#failure !== null) return;
    this.#failure = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      entry.reject(new Error(`${entry.method}: ${reason.message}`, { cause: reason }));
    }
  }

  async #onRequest(method: string, frame: Record<string, unknown>): Promise<void> {
    const id = frame.id as RpcId;
    const handler = this.#requests.get(method);

    if (handler === undefined) {
      // Decision: an error, never silence. Silence parks the far side forever.
      this.#send(errorReply(id, RPC_METHOD_NOT_FOUND, `method not found: ${method}`));
      return;
    }

    try {
      const result = await handler(frame.params);
      this.#send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (cause) {
      // Decision: a throwing handler still answers. An exception escaping here
      // would be indistinguishable, from the far side, from a lost request.
      const error =
        cause instanceof RpcError
          ? { code: cause.code, message: cause.message, data: cause.data }
          : { code: RPC_INTERNAL_ERROR, message: messageOf(cause) };
      this.#send({ jsonrpc: '2.0', id, error });
    }
  }

  #onNotification(method: string, frame: Record<string, unknown>): void {
    const handler = this.#notifications.get(method);
    if (handler === undefined) {
      // Not an error on the wire -- a notification has no reply by definition,
      // so there is nobody to tell. It is surfaced locally instead, because an
      // unhandled notification is how a surface quietly stops showing something.
      this.#onProtocolError(`unhandled notification: ${method}`, frame);
      return;
    }
    try {
      handler(frame.params);
    } catch (cause) {
      this.#onProtocolError(`notification handler threw: ${messageOf(cause)}`, frame);
    }
  }

  #onResponse(frame: Record<string, unknown>): void {
    const key = String(frame.id);
    const pending = this.#pending.get(key);

    if (pending === undefined) {
      // A response to an id we never sent, or a duplicate for one already
      // settled. Reported rather than dropped: it means the two sides disagree
      // about what is outstanding.
      this.#onProtocolError(`response for unknown id: ${key}`, frame);
      return;
    }

    this.#pending.delete(key);

    if (isObject(frame.error)) {
      const error = frame.error;
      pending.reject(
        new RpcError(
          typeof error.code === 'number' ? error.code : RPC_INTERNAL_ERROR,
          typeof error.message === 'string' ? error.message : 'unknown RPC error',
          error.data,
        ),
      );
      return;
    }

    pending.resolve(frame.result ?? null);
  }
}

function payload(method: string, params: unknown, id: RpcId | undefined): Record<string, unknown> {
  const message: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (id !== undefined) message.id = id;
  // Omitted rather than sent as null: `"params": null` is not the same as no
  // params, and a strict peer is entitled to reject it.
  if (params !== undefined) message.params = params;
  return message;
}

function errorReply(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
