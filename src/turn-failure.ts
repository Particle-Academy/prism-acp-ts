import { bindingWindow, readRateLimit } from './claude/rate-limit.js';
import { REDACTED } from './redact.js';
import { MAX_PROVIDER_TEXT_CHARS, PROVIDER_TEXT_TRUNCATED, boundProviderText } from './text.js';

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
  /**
   * UNTRUSTED provider-supplied text (G-311): Codex's own `TurnError.message`, e.g. why a `cyberPolicy` stop happened.
   * Shown as-is it could say anything, so it is bounded to `MAX_PROVIDER_TEXT_CHARS` with `PROVIDER_TEXT_TRUNCATED`
   * appended, and every hidden or control character is marked `<U+XXXX>` (src/text.ts). It never decides `reason` or
   * `kind`: those come from `codexErrorInfo` alone. Absent when the provider sent no message.
   */
  readonly providerMessage?: string;
  /**
   * UNTRUSTED provider-supplied detail fields, from an ALLOWLIST of plain scalars only (`CODEX_DETAIL_FIELDS`); strings
   * are bounded and marked as `providerMessage` is. Absent when none was sent.
   */
  readonly providerDetails?: Readonly<Record<string, string | number>>;
  /**
   * True when waiting and sending the prompt again is the remedy: `overloaded` and `rate_limit`, and nothing else. It
   * follows the kind alone ({@link isRetryableKind}); absent on every other kind, which is no claim either way.
   */
  readonly retryable?: true;
  /**
   * How long the PROVIDER asked to wait, in milliseconds, when it said and the driver could read it. Never invented:
   * not a backoff of ours, and not a CLI's own retry wait (Claude Code's `api_retry.retry_delay_ms` is its jittered
   * wait, not the provider's statement). An integer from 0 to {@link MAX_RETRY_AFTER_MS}; only on a retryable failure.
   * Neither shipped CLI forwards the provider's `retry-after` (Claude Code 2.1.332, codex-cli 0.163.0, measured), so
   * today it comes only from an embedder's own driver.
   */
  readonly retryAfterMs?: number;
  /**
   * Whether the SAME session takes the next `session/prompt` and continues the conversation. True only where measured:
   * the shipped drivers on `overloaded` and `rate_limit`, and only while the agent process is still running. False when
   * the session's agent is gone. Absent means no claim.
   */
  readonly resumable?: boolean;
}

export type TurnFailureKind = 'rate_limit' | 'overloaded' | 'auth' | 'billing' | 'other';

/** The longest retry-after forwarded: one hour. A longer statement is capped to it, so a client never parks forever. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** Whether a kind is one a client should wait out and retry. */
export function isRetryableKind(kind: TurnFailureKind): boolean {
  return kind === 'overloaded' || kind === 'rate_limit';
}

/** A stated retry-after, bounded: a finite number of ms >= 0, rounded up to an integer and capped; anything else undefined. */
export function boundRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.ceil(value), MAX_RETRY_AFTER_MS);
}

const KINDS: ReadonlySet<string> = new Set<TurnFailureKind>(['rate_limit', 'overloaded', 'auth', 'billing', 'other']);
/** The wire's bound on provider text: the driver's own bound plus its marker, so text a driver already bounded is unchanged. */
const WIRE_TEXT_MAX = MAX_PROVIDER_TEXT_CHARS + PROVIDER_TEXT_TRUNCATED.length;
const DETAIL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** The last instant a JavaScript Date can hold. */
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_DETAILS = 16;

/**
 * A failure as the wire carries it, rebuilt -- never the driver's object. The transport calls JSON.stringify, so an own
 * `toJSON`, a getter or a Proxy would decide what is sent after any check; the failure is therefore read ONCE, as it
 * serializes, and only the documented fields are taken from that snapshot, each checked:
 *   reason (non-empty string, bounded and marked as provider text), kind (one of the five, else `other`),
 *   resetsAtMs (0 to the last JavaScript date, rounded up to a whole millisecond), providerMessage (string, bounded and marked), providerDetails (at most
 *   16 plain-named scalar fields, strings bounded and marked);
 *   retryable from the kind alone; retryAfterMs bounded and only on a retryable failure; resumable the driver's boolean
 *   claim, and false whatever it said when the agent is no longer running -- as of this reply: an agent that exits
 *   after it is answered `session_exited` on the next prompt.
 * Undefined when the failure cannot be serialized or names no reason: then no failure data is sent, as for a turn the
 * provider gave no reason for.
 */
export function wireTurnFailure(failure: unknown, agentRunning: boolean): TurnFailure | undefined {
  let snapshot: unknown;
  try {
    const text = JSON.stringify(failure);
    snapshot = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
  if (!isRecord(snapshot)) return undefined;
  const reason = own(snapshot, 'reason');
  if (typeof reason !== 'string' || reason === '') return undefined;
  const kindValue = own(snapshot, 'kind');
  const kind: TurnFailureKind = typeof kindValue === 'string' && KINDS.has(kindValue) ? kindValue as TurnFailureKind : 'other';
  // A time JavaScript can represent as a date (0 to 8.64e15 ms, G-97), rounded up to a whole millisecond: fractional
  // seconds from a provider keep their reset, and a client's `new Date(resetsAtMs).toISOString()` never throws.
  const resetsAtMs = own(snapshot, 'resetsAtMs');
  const reset = typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs) && resetsAtMs >= 0 && resetsAtMs <= MAX_DATE_MS
    ? Math.ceil(resetsAtMs) : undefined;
  const message = own(snapshot, 'providerMessage');
  const details = wireDetails(own(snapshot, 'providerDetails'));
  const retryable = isRetryableKind(kind);
  const after = retryable ? boundRetryAfterMs(own(snapshot, 'retryAfterMs')) : undefined;
  const claim = own(snapshot, 'resumable');
  const resume = agentRunning ? (typeof claim === 'boolean' ? claim : undefined) : false;
  return {
    reason: boundProviderText(reason, WIRE_TEXT_MAX),
    kind,
    ...(reset === undefined ? {} : { resetsAtMs: reset }),
    ...(typeof message === 'string' && message !== '' ? { providerMessage: boundProviderText(message, WIRE_TEXT_MAX) } : {}),
    ...(details === undefined ? {} : { providerDetails: details }),
    ...(retryable ? { retryable: true as const } : {}),
    ...(after === undefined ? {} : { retryAfterMs: after }),
    ...(resume === undefined ? {} : { resumable: resume }),
  };
}

function wireDetails(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const details = new Map<string, string | number>();
  for (const name of Object.keys(value)) {
    if (details.size >= MAX_DETAILS) break;
    if (!DETAIL_NAME.test(name)) continue;
    const entry = value[name];
    if (typeof entry === 'string' && entry !== '') details.set(name, boundProviderText(entry, WIRE_TEXT_MAX));
    if (typeof entry === 'number' && Number.isSafeInteger(entry)) details.set(name, entry);
  }
  return details.size === 0 ? undefined : Object.fromEntries(details);
}

/**
 * A shipped driver's failure, with what was MEASURED of its CLI: on a retryable kind the process stays and the next
 * prompt continues the conversation (Claude Code 2.1.332 and codex-cli 0.163.0 against a loopback model answering 529
 * and 429, 2026-11-25), so `retryable` and `resumable` are true. No retry-after: neither CLI forwards one.
 */
function measured(failure: TurnFailure): TurnFailure {
  return isRetryableKind(failure.kind) ? { ...failure, retryable: true, resumable: true } : failure;
}

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
/**
 * The kind of a Claude failure whose `error` names none, from the HTTP status and API error type the CLI carries beside
 * it. Claude Code 2.1.332 ends a 529 with `error: "server_error"`, `api_error_status: 529` and `api_error_type:
 * "overloaded_error"` (measured): read by `error` alone it was `other`, and nothing retried it.
 */
function claudeKindOf(status: number | null, type: string | null): TurnFailureKind {
  if (status === 529 || type === 'overloaded_error') return 'overloaded';
  if (status === 429 || type === 'rate_limit_error') return 'rate_limit';
  return 'other';
}

export class ClaudeTurnFailures {
  #reason: string | null = null;
  #status: number | null = null;
  #type: string | null = null;
  #resetsAtMs: number | null = null;

  observe(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return;
    const value = frame as Record<string, unknown>;

    // The main thread's error only: a subagent's failure is reported inside its own tool result, and is not why this
    // turn ended.
    if (value.type === 'assistant' && typeof value.error === 'string'
      && (value.parent_tool_use_id === null || value.parent_tool_use_id === undefined)) {
      this.#reason = value.error;
      const status = own(value, 'api_error_status');
      const type = own(value, 'api_error_type');
      this.#status = typeof status === 'number' && Number.isSafeInteger(status) ? status : null;
      this.#type = typeof type === 'string' ? type : null;
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
    const status = this.#status;
    const type = this.#type;
    this.#reason = null;
    this.#resetsAtMs = null;
    this.#status = null;
    this.#type = null;
    if (reason === null) return undefined;

    const named = kindOf(CLAUDE_KINDS, reason);
    const kind = named === 'other' ? claudeKindOf(status, type) : named;
    return measured(kind === 'rate_limit' && resetsAtMs !== null ? { reason, kind, resetsAtMs } : { reason, kind });
  }
}

/**
 * The detail fields a Codex failure may forward, and where each is read (codex app-server v2 `TurnError`): the error's
 * own `additionalDetails`; the `codexErrorInfo` object variant's `httpStatusCode` / `turnKind`; a misalignment block's
 * `errorType` / `detailedExplanation`. Nothing else is read -- not `misalignment.steer` (an instruction to submit as the
 * next user turn), not `reviewTarget` (an opaque server-issued token), and never the raw frame. Only a non-empty string
 * or a safe integer is taken; an object, array, boolean or float is dropped, never stringified.
 */
const CODEX_DETAIL_FIELDS: readonly {
  readonly name: string;
  readonly from: 'error' | 'info' | 'misalignment';
  readonly key: string;
  readonly type: 'string' | 'integer';
}[] = [
  { name: 'additionalDetails', from: 'error', key: 'additionalDetails', type: 'string' },
  { name: 'httpStatusCode', from: 'info', key: 'httpStatusCode', type: 'integer' },
  { name: 'turnKind', from: 'info', key: 'turnKind', type: 'string' },
  { name: 'misalignmentErrorType', from: 'misalignment', key: 'errorType', type: 'string' },
  { name: 'misalignmentExplanation', from: 'misalignment', key: 'detailedExplanation', type: 'string' },
];

/** How {@link codexFailureOf} treats provider text. */
export interface CodexFailureOptions {
  /**
   * Secrets this process holds (the API key Codex was logged in with) to replace with `[redacted]` in provider text
   * BEFORE it is marked and cut, so a provider that echoes a key never forwards it, whole or in part.
   */
  readonly redact?: readonly string[];
}

/** A failed Codex turn's `error` (TurnError), as a failure; undefined when it names no reason. */
export function codexFailureOf(error: unknown, options: CodexFailureOptions = {}): TurnFailure | undefined {
  if (!isRecord(error)) return undefined;
  const info = own(error, 'codexErrorInfo');

  let reason: string | undefined;
  let variant: unknown;
  if (typeof info === 'string') reason = info;
  else if (isRecord(info)) {
    reason = Object.keys(info)[0];
    if (reason !== undefined) variant = own(info, reason);
  }
  if (reason === undefined || reason === '') return undefined;

  // The code and kind are settled here, from codexErrorInfo alone: nothing the provider wrote below can change them.
  const named = kindOf(CODEX_KINDS, reason);
  const failure: TurnFailure = { reason, kind: named === 'other' ? codexStatusKind(variant) : named };
  const secrets = (options.redact ?? []).filter((secret) => secret !== '');
  const clean = (text: string): string => boundProviderText(secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text));
  const message = own(error, 'message');
  const providerMessage = typeof message === 'string' && message !== '' ? clean(message) : undefined;
  const providerDetails = codexDetails({ error, info: variant, misalignment: own(error, 'misalignment') }, clean);
  return measured({
    ...failure,
    ...(providerMessage === undefined ? {} : { providerMessage }),
    ...(providerDetails === undefined ? {} : { providerDetails }),
  });
}

/**
 * The kind an HTTP-carrying `codexErrorInfo` variant names by its status. codex-cli 0.163.0 ends a turn whose provider
 * kept answering 529 with `httpConnectionFailed: { httpStatusCode: 529 }`, and one that kept answering 429 with
 * `responseTooManyFailedAttempts: { httpStatusCode: 429 }` (measured): neither is `serverOverloaded` or
 * `rateLimitExceeded`, so read by name alone both were `other`. Only an own integer status counts.
 */
function codexStatusKind(variant: unknown): TurnFailureKind {
  if (!isRecord(variant)) return 'other';
  const status = own(variant, 'httpStatusCode');
  if (status === 529) return 'overloaded';
  if (status === 429) return 'rate_limit';
  return 'other';
}

function codexDetails(
  sources: Readonly<Record<'error' | 'info' | 'misalignment', unknown>>,
  clean: (text: string) => string,
): Record<string, string | number> | undefined {
  // A Map, then a plain object built only from the allowlist's own names: no provider key ever becomes a property.
  const details = new Map<string, string | number>();
  for (const field of CODEX_DETAIL_FIELDS) {
    const source = sources[field.from];
    if (!isRecord(source)) continue;
    const entry = own(source, field.key);
    if (field.type === 'string' && typeof entry === 'string' && entry !== '') details.set(field.name, clean(entry));
    if (field.type === 'integer' && typeof entry === 'number' && Number.isSafeInteger(entry)) details.set(field.name, entry);
  }
  return details.size === 0 ? undefined : Object.fromEntries(details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An OWN property, or undefined: `__proto__` and `constructor` never answer from the prototype (G-96). */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * A provider's reason as a kind. An OWN property only: indexing the table directly answered `constructor` with a
 * function, which JSON drops, so the client got a failure with no kind at all (G-96).
 */
function kindOf(kinds: Readonly<Record<string, TurnFailureKind>>, reason: string): TurnFailureKind {
  return Object.hasOwn(kinds, reason) ? kinds[reason]! : 'other';
}
