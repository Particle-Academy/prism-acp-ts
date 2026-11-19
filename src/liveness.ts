/**
 * Liveness: is the provider process still answering (G-314, Tynn #855)?
 *
 * A host showing a turn that has gone quiet needs to tell a provider that is THINKING from one that is STALLED, and
 * offer Stop/Restart only for the second. Silence alone cannot say which: a long tool call is silent too. So each
 * driver can `ping()` -- send the provider one harmless, read-only request and see whether it answers -- and report
 * `lastFrameAt`, when the provider last wrote anything.
 *
 * The semantics are the same in both drivers, and live here so they cannot drift apart:
 *
 * - `ping()` NEVER rejects. It resolves `true` when the provider answered the request (an error answer counts: the
 *   provider read and processed it), and `false` when it did not answer within the timeout, when the request could
 *   not be written, when the process exited first, or when the driver is not running. One boolean, one meaning.
 * - The timeout is clamped to [{@link PING_TIMEOUT_MIN_MS}, {@link PING_TIMEOUT_MAX_MS}];
 *   omitted or non-finite means {@link PING_TIMEOUT_DEFAULT_MS}.
 * - At most one ping per driver is in flight. Concurrent calls share it, including the FIRST caller's timeout.
 * - At most one probe REQUEST per driver is on the wire. A ping that timed out leaves its request outstanding, and
 *   the next ping waits on that same request instead of writing another, so a stalled provider is never sent a growing
 *   queue of probes. Both providers answer every request (JSON-RPC, and the CLI's control protocol, reply to each), so
 *   the outstanding request settles when the provider recovers or when it exits.
 */

export const PING_TIMEOUT_DEFAULT_MS = 5_000;
export const PING_TIMEOUT_MIN_MS = 100;
export const PING_TIMEOUT_MAX_MS = 60_000;

export interface PingOptions {
  /** How long to wait for the answer. Clamped to 100..60000 ms; default 5000. */
  readonly timeoutMs?: number;
}

/** The timeout a ping actually uses for a caller's `timeoutMs`. */
export function pingTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PING_TIMEOUT_DEFAULT_MS;
  return Math.min(PING_TIMEOUT_MAX_MS, Math.max(PING_TIMEOUT_MIN_MS, Math.round(value)));
}

/**
 * The one-in-flight bookkeeping both drivers share. `send` writes ONE probe request and returns a promise that resolves
 * when the provider answers it (by its own id) and rejects when it cannot be answered (write failure, process exit).
 */
export class LivenessGate {
  #request: Promise<boolean> | null = null;
  #ping: Promise<boolean> | null = null;

  ping(timeoutMs: number, send: () => Promise<unknown>): Promise<boolean> {
    if (this.#ping !== null) return this.#ping;

    if (this.#request === null) {
      let sent: Promise<unknown>;
      try { sent = send(); }
      catch { return Promise.resolve(false); }
      const request: Promise<boolean> = sent.then(() => true, () => false).finally(() => {
        if (this.#request === request) this.#request = null;
      });
      this.#request = request;
    }

    const request = this.#request;
    const ping: Promise<boolean> = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      void request.then((answered) => { clearTimeout(timer); resolve(answered); });
    }).finally(() => {
      if (this.#ping === ping) this.#ping = null;
    });
    this.#ping = ping;
    return ping;
  }
}
