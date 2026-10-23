import { bindingWindow, readRateLimit } from './claude/rate-limit.js';

/**
 * Why a turn failed, when the provider said: carried on `TurnOutcome.failure` and on the error a failed
 * `session/prompt` answers with (`_meta[particle.academy/turn_failure]`).
 *
 * A client that holds a turn "until the limit resets" needs to know the turn failed ON the limit. Before this it could
 * only infer that from a rate-limit event arriving in the same turn, and a turn the CLI ended with an error and no
 * event read as an ordinary failure that nothing resumed (tynn #791).
 */
export interface TurnFailure {
  /** The provider's own reason, verbatim: Claude's assistant `error`, or Codex's `codexErrorInfo` (an object variant's key). */
  readonly reason: string;
  /** What a client can act on. Anything not recognised is `other`, with the reason still verbatim. */
  readonly kind: TurnFailureKind;
  /** When the limit resets, in epoch milliseconds, ONLY when a rate-limit event in the same turn said so. Never invented. */
  readonly resetsAtMs?: number;
}

export type TurnFailureKind = 'rate_limit' | 'overloaded' | 'auth' | 'billing' | 'other';

/**
 * Claude Code's assistant `error` values, from its own schema (claude-code 2.1.301). An unknown value is `other`, never
 * dropped: the provider adds reasons, and a new one must still reach the client.
 */
const CLAUDE_KINDS: Readonly<Record<string, TurnFailureKind>> = {
  rate_limit: 'rate_limit',
  overloaded: 'overloaded',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'billing',
  account_on_hold: 'billing',
  verification_required: 'billing',
};

/**
 * Codex's `codexErrorInfo` values (codex-cli 0.156.1). A usage limit is a plan's quota window, so it is held and resumed
 * like a rate limit.
 */
const CODEX_KINDS: Readonly<Record<string, TurnFailureKind>> = {
  usageLimitExceeded: 'rate_limit',
  rateLimitExceeded: 'rate_limit',
  serverOverloaded: 'overloaded',
  unauthorized: 'auth',
};

/**
 * One Claude turn's failure, read from the frames as they pass. Fed every frame the driver accepts; `take()` at the
 * turn's `result` returns the failure (if any) and starts the next turn clean.
 */
export class ClaudeTurnFailures {
  #reason: string | null = null;
  #resetsAtMs: number | null = null;

  observe(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return;
    const value = frame as Record<string, unknown>;

    // The main thread's error only: a subagent's failure is reported inside its own tool result, and is not why this
    // turn ended.
    if (value.type === 'assistant' && typeof value.error === 'string'
      && (value.parent_tool_use_id === null || value.parent_tool_use_id === undefined)) {
      this.#reason = value.error;
    }

    // A breached window's reset: the only reset this failure may report. An `allowed` event is not a breach.
    if (value.type === 'rate_limit_event') {
      const read = readRateLimit(value.rate_limit_info ?? value);
      if (read.ok && read.limit.status !== 'allowed') {
        const binding = bindingWindow(read.limit);
        this.#resetsAtMs = binding?.resetsAtMs ?? read.limit.resetsAtMs;
      }
    }
  }

  /** The turn's failure, or undefined; clears for the next turn either way. */
  take(): TurnFailure | undefined {
    const reason = this.#reason;
    const resetsAtMs = this.#resetsAtMs;
    this.#reason = null;
    this.#resetsAtMs = null;
    if (reason === null) return undefined;

    const kind = kindOf(CLAUDE_KINDS, reason);
    return kind === 'rate_limit' && resetsAtMs !== null ? { reason, kind, resetsAtMs } : { reason, kind };
  }
}

/** A failed Codex turn's `error` (TurnError), as a failure; undefined when it names no reason. */
export function codexFailureOf(error: unknown): TurnFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const info = (error as Record<string, unknown>).codexErrorInfo;

  let reason: string | undefined;
  if (typeof info === 'string') reason = info;
  else if (typeof info === 'object' && info !== null) reason = Object.keys(info)[0];
  if (reason === undefined || reason === '') return undefined;

  return { reason, kind: kindOf(CODEX_KINDS, reason) };
}

/**
 * A provider's reason as a kind. An OWN property only: indexing the table directly answered `constructor` with a
 * function, which JSON drops, so the client got a failure with no kind at all (G-96).
 */
function kindOf(kinds: Readonly<Record<string, TurnFailureKind>>, reason: string): TurnFailureKind {
  return Object.hasOwn(kinds, reason) ? kinds[reason]! : 'other';
}
