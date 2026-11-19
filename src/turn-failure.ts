import { bindingWindow, readRateLimit } from './claude/rate-limit.js';
import { REDACTED } from './redact.js';
import { boundProviderText } from './text.js';

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
  const failure: TurnFailure = { reason, kind: kindOf(CODEX_KINDS, reason) };
  const secrets = (options.redact ?? []).filter((secret) => secret !== '');
  const clean = (text: string): string => boundProviderText(secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text));
  const message = own(error, 'message');
  const providerMessage = typeof message === 'string' && message !== '' ? clean(message) : undefined;
  const providerDetails = codexDetails({ error, info: variant, misalignment: own(error, 'misalignment') }, clean);
  return {
    ...failure,
    ...(providerMessage === undefined ? {} : { providerMessage }),
    ...(providerDetails === undefined ? {} : { providerDetails }),
  };
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
