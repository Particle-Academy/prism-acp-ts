/**
 * One provider-neutral reading of usage windows (G-328).
 *
 * Claude and Codex describe limits differently: Claude names its windows and never states their length, Codex has two
 * slots whose length decides what they are. A consumer drawing one gauge should not have to know either. The rule
 * throughout is that this type never states more than the provider did: a length, a percentage or a binding window it
 * did not report stays null or absent, and an empty list is never allowed to read as plenty of headroom.
 */
import { bindingWindow, readRateLimit } from './claude/rate-limit.js';
import { readCodexRateLimit, type CodexRateLimitWindow } from './codex/rate-limit.js';
import { boundProviderText, stripAnsiControlSequences } from './text.js';

/**
 * - `reported`: the provider gave a reading, and `windows` is it.
 * - `not_yet_reported`: nothing has arrived yet.
 * - `unreadable`: a payload was refused whole; `reason` says why and `windows` is empty.
 * - `unsupported`: this session has no usage windows to read (an API-key session).
 */
export type RateLimitReadingState = 'reported' | 'not_yet_reported' | 'unreadable' | 'unsupported';

/**
 * How to read a window missing from `windows`. `provider_says_none` means the provider explicitly reported no window;
 * `not_stated` means this reading does not say, so the window may still exist.
 */
export type RateLimitAbsent = 'provider_says_none' | 'not_stated';

export interface RateLimitReadingWindow {
  /** Stable across readings: `claude:<provider key>`, or `codex:<minutes>m` from the length and never the slot. */
  readonly id: string;
  readonly label: string;
  /** Null when the provider did not state the length. Never inferred from a window's name. */
  readonly lengthSeconds: number | null;
  /** Not capped: above 100 is real overage. Null when the provider did not state it; never a guessed 100. */
  readonly usedPercent: number | null;
  readonly resetsAtMs: number | null;
  /** True on the window the provider names as binding. ABSENT when it does not say; never false as a guess. */
  readonly binding?: boolean;
  /** True when the provider's own status for this window is not `allowed`. ABSENT otherwise. */
  readonly limited?: boolean;
  /**
   * What the window is limited to, when the provider says. ABSENT when it does not: a key name such as
   * `seven_day_opus` is never turned into a scope. Today only Claude's per-model caps (`model_scoped`) carry one.
   */
  readonly scope?: RateLimitWindowScope;
}

export interface RateLimitWindowScope {
  /** The provider's own label for the model bucket (`Fable`), cleaned and bounded. */
  readonly model?: string;
}

/**
 * Why an account read (`claudeAccounts.readRateLimits`) knows nothing. Only that read sets it; a session's readings
 * never do.
 */
export type RateLimitUnknownReason =
  | 'no_plan_limits'
  | 'unavailable'
  | 'refused'
  | 'malformed'
  | 'timeout'
  | 'cli_unavailable'
  | 'cli_exited'
  | 'too_large'
  | 'invalid_options';

export interface RateLimitReading {
  readonly state: RateLimitReadingState;
  /** Why a payload was refused, when `state` is `unreadable`. Describes values by type and never quotes them. */
  readonly reason?: string;
  /** When this reading was taken, in epoch milliseconds. */
  readonly asOfMs: number;
  /**
   * True when the provider clearly says usage is limited now, even with no percentage to show. False is only
   * meaningful when `state` is `reported`: every other state knows nothing about the limit.
   */
  readonly limited: boolean;
  readonly windows: readonly RateLimitReadingWindow[];
  readonly absent: RateLimitAbsent;
  /** Set only by an account read that knows nothing (`unreadable` or `unsupported`). See {@link RateLimitUnknownReason}. */
  readonly reasonCode?: RateLimitUnknownReason;
}

/** More than any provider reports. A payload past it is refused rather than truncated, which would be a partial. */
const MAX_WINDOWS = 16;
/** Window names become ids and labels a host may render, so only short, plain names are carried. */
const SAFE_WINDOW_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function empty(state: RateLimitReadingState, asOfMs: number, reason?: string): RateLimitReading {
  return { state, ...(reason === undefined ? {} : { reason }), asOfMs, limited: false, windows: [], absent: 'not_stated' };
}

export function notYetReportedRateLimitReading(asOfMs: number): RateLimitReading {
  return empty('not_yet_reported', asOfMs);
}

export function unsupportedRateLimitReading(asOfMs: number): RateLimitReading {
  return empty('unsupported', asOfMs);
}

/** A refusal. The caller's `reason` must already be free of provider values. */
export function unreadableRateLimitReading(reason: string, asOfMs: number): RateLimitReading {
  return empty('unreadable', asOfMs, reason);
}

function unsafeName(path: string, value: unknown): string {
  const got = typeof value === 'string' ? `string(${value.length})` : typeof value;
  return `rate_limit_reading: ${path} expected a plain name of at most 64 characters, got ${got}`;
}

/** Checked BEFORE parsing, because the parser's refusal reasons name the window key. */
function refusedClaudeNames(payload: unknown): string | undefined {
  if (!isObject(payload) || !isObject(payload.unifiedWindows)) return undefined;
  const names = Object.keys(payload.unifiedWindows);
  if (names.length > MAX_WINDOWS) {
    return `rate_limit_reading: unifiedWindows expected at most ${MAX_WINDOWS} windows, got ${names.length}`;
  }
  const index = names.findIndex((name) => !SAFE_WINDOW_NAME.test(name));
  return index === -1 ? undefined : unsafeName(`unifiedWindows key ${index}`, names[index]);
}

/** Removes binary float noise (0.29 * 100 is 28.999999999999996) without capping the value. */
function percentOf(utilization: number): number {
  return Number((utilization * 100).toPrecision(12));
}

function claudeWindowLimited(payload: Record<string, unknown>, name: string): boolean {
  const windows = payload.unifiedWindows;
  if (!isObject(windows) || !Object.hasOwn(windows, name)) return false;
  const window = windows[name];
  return isObject(window) && typeof window.status === 'string' && window.status !== 'allowed';
}

/**
 * Read a Claude `rate_limit_info` payload. `absent` is always `not_stated`: Claude omits a window by leaving out its
 * key, so one frame is no proof the account lacks it.
 */
export function claudeRateLimitReading(payload: unknown, asOfMs: number): RateLimitReading {
  const refusedName = refusedClaudeNames(payload);
  if (refusedName !== undefined) return unreadableRateLimitReading(refusedName, asOfMs);

  const read = readRateLimit(payload);
  if (!read.ok) return unreadableRateLimitReading(read.reason, asOfMs);

  const { limit } = read;
  const limited = limit.status !== 'allowed';
  const bound = bindingWindow(limit);
  const windows: RateLimitReadingWindow[] = [];
  for (const [name, window] of Object.entries(limit.windows)) {
    const usedPercent = percentOf(window.utilization);
    // JSON would carry Infinity as null, which here means "not stated".
    if (!Number.isFinite(usedPercent)) {
      return unreadableRateLimitReading(`rate_limit_reading: window ${windows.length} utilization is too large to state as a percentage`, asOfMs);
    }
    windows.push({
      id: `claude:${name}`,
      label: name.replaceAll('_', ' '),
      lengthSeconds: null,
      usedPercent,
      resetsAtMs: window.resetsAtMs,
      ...(window === bound ? { binding: true } : {}),
      ...(claudeWindowLimited(limit.raw, name) ? { limited: true } : {}),
    });
  }

  // A rejection can name its window without reporting any figures for it.
  if (limited && bound === undefined) {
    if (!SAFE_WINDOW_NAME.test(limit.rateLimitType)) {
      return unreadableRateLimitReading(unsafeName('rateLimitType', limit.rateLimitType), asOfMs);
    }
    if (windows.length >= MAX_WINDOWS) {
      return unreadableRateLimitReading(`rate_limit_reading: unifiedWindows expected at most ${MAX_WINDOWS} windows, got ${windows.length + 1}`, asOfMs);
    }
    windows.push({
      id: `claude:${limit.rateLimitType}`,
      label: limit.rateLimitType.replaceAll('_', ' '),
      lengthSeconds: null,
      usedPercent: null,
      resetsAtMs: limit.resetsAtMs,
      binding: true,
    });
  }

  return { state: 'reported', asOfMs, limited, windows, absent: 'not_stated' };
}

function lengthLabel(minutes: number): string {
  const [amount, unit] = minutes % 1440 === 0 ? [minutes / 1440, 'day'] : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

function isStated(rates: Record<string, unknown>, slot: 'primary' | 'secondary'): boolean {
  return Object.hasOwn(rates, slot) && rates[slot] !== undefined;
}

export interface CodexRateLimitReadingOptions {
  /**
   * The payload is an `account/rateLimits/updated` notification, which Codex's schema calls a SPARSE update to merge
   * into the last full read. A null slot there does not mean the window is gone, so `absent` stays `not_stated`.
   */
  readonly sparse?: boolean;
}

/**
 * Read a Codex rate-limit payload.
 *
 * `binding` is never set: every `rateLimitReachedType` in Codex's schema (0.163.0) names a cause, none names a window.
 * `provider_says_none` needs a full read in which every slot was stated and at least one was an explicit null.
 */
export function codexRateLimitReading(payload: unknown, asOfMs: number, options: CodexRateLimitReadingOptions = {}): RateLimitReading {
  if (isObject(payload) && payload.rateLimits !== undefined && !isObject(payload.rateLimits)) {
    const got = payload.rateLimits === null ? 'null' : typeof payload.rateLimits;
    return unreadableRateLimitReading(`codex_rate_limit: rateLimits expected an object, got ${got}`, asOfMs);
  }
  if (!isObject(payload)) {
    const refused = readCodexRateLimit(payload);
    return unreadableRateLimitReading(refused.ok ? 'codex_rate_limit: payload expected an object' : refused.reason, asOfMs);
  }

  const rates = isObject(payload.rateLimits) ? payload.rateLimits : payload;
  const primaryStated = isStated(rates, 'primary');
  const secondaryStated = isStated(rates, 'secondary');
  const sparse = options.sparse === true;
  // A full read naming neither slot is a renamed or unknown shape, and must not read as "no windows".
  if (!sparse && !primaryStated && !secondaryStated) {
    return unreadableRateLimitReading('codex_rate_limit: rateLimits expected primary or secondary, got neither', asOfMs);
  }

  // Omission is recorded above, so the parser can be handed explicit nulls whether or not it accepts an omitted key.
  const filled = { ...rates, primary: primaryStated ? rates.primary : null, secondary: secondaryStated ? rates.secondary : null };
  const read = readCodexRateLimit(rates === payload ? filled : { ...payload, rateLimits: filled });
  if (!read.ok) return unreadableRateLimitReading(read.reason, asOfMs);

  const slots = [read.limit.primary, read.limit.secondary].filter((window): window is CodexRateLimitWindow => window !== null);
  const windows: RateLimitReadingWindow[] = [];
  for (const window of slots) {
    const lengthSeconds = window.windowDurationMins * 60;
    if (!Number.isSafeInteger(lengthSeconds)) {
      return unreadableRateLimitReading('codex_rate_limit: windowDurationMins is too large to state in seconds', asOfMs);
    }
    const base = `codex:${window.windowDurationMins}m`;
    windows.push({
      id: windows.some((existing) => existing.id === base) ? `${base}:2` : base,
      label: lengthLabel(window.windowDurationMins),
      lengthSeconds,
      usedPercent: window.usedPercent,
      resetsAtMs: window.resetsAtMs,
    });
  }

  const everySlotStated = primaryStated && secondaryStated;
  const saysNone = !sparse && everySlotStated && (rates.primary === null || rates.secondary === null);
  const limited = read.limit.ordinaryUsageAllowed === false || (read.limit.rateLimitReachedType ?? null) !== null;
  return { state: 'reported', asOfMs, limited, windows, absent: saysNone ? 'provider_says_none' : 'not_stated' };
}

/** An account read that knows nothing, with its reason code. `reason` must already be free of provider values. */
export function unknownRateLimitReading(reasonCode: RateLimitUnknownReason, reason: string, asOfMs: number): RateLimitReading {
  const state: RateLimitReadingState = reasonCode === 'no_plan_limits' ? 'unsupported' : 'unreadable';
  return { ...empty(state, asOfMs, state === 'unreadable' ? reason : undefined), reasonCode };
}

/** The windows Claude Code's `get_usage` schema declares. A non-null one of another shape refuses the payload. */
const CLAUDE_USAGE_DECLARED = new Set(['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']);
const MAX_MODEL_LABEL = 64;

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

type UsageWindowRead =
  | { readonly ok: true; readonly usedPercent: number | null; readonly resetsAtMs: number | null }
  | { readonly ok: false; readonly reason: string };

function isUsageWindow(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Object.hasOwn(value, 'utilization') && Object.hasOwn(value, 'resets_at');
}

/** `utilization` is a PERCENT here (schema: "0-100"), unlike the stream event's fraction; `resets_at` is ISO 8601. */
function readUsageWindow(path: string, window: Record<string, unknown>): UsageWindowRead {
  const { utilization, resets_at: resetsAt } = window;
  if (utilization !== null && (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0)) {
    return { ok: false, reason: `claude_usage: ${path}.utilization expected a finite number >= 0 or null, got ${describeValue(utilization)}` };
  }
  let resetsAtMs: number | null = null;
  if (resetsAt !== null) {
    const parsed = typeof resetsAt === 'string' ? Date.parse(resetsAt) : Number.NaN;
    if (!Number.isFinite(parsed)) return { ok: false, reason: `claude_usage: ${path}.resets_at expected an ISO 8601 date or null, got ${describeValue(resetsAt)}` };
    resetsAtMs = parsed;
  }
  return { ok: true, usedPercent: utilization === null ? null : Number(utilization.toPrecision(12)), resetsAtMs };
}

/** Server text for a model bucket: escapes removed, hidden characters marked, bounded. */
function modelLabel(value: string): string {
  return boundProviderText(stripAnsiControlSequences(value).text.trim(), MAX_MODEL_LABEL);
}

function modelSlug(label: string): string {
  const slug = label.replace(/<U\+[0-9A-F]+>/g, '').toLowerCase().replace(/[^a-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return slug === '' ? 'model' : slug;
}

/**
 * Read the answer to Claude Code's `get_usage` control request (measured on claude-code 2.1.332; the CLI marks the
 * request experimental, so a changed shape is refused as `malformed` rather than guessed at).
 *
 * A window is any own key of `rate_limits` holding `{ utilization, resets_at }`, so a window the server adds later is
 * carried without a release; `model_scoped[]` rows are per-model weekly caps and carry `scope.model`. This source never
 * states a length or a binding window, so those stay null and absent. Nothing else in the answer (plan, spend,
 * credits, session cost, code-name keys) is carried.
 */
export function claudeUsageRateLimitReading(payload: unknown, asOfMs: number): RateLimitReading {
  const malformed = (reason: string) => unknownRateLimitReading('malformed', reason, asOfMs);
  if (!isObject(payload)) return malformed(`claude_usage: answer expected an object, got ${describeValue(payload)}`);
  if (payload.rate_limits_available === false) return unknownRateLimitReading('no_plan_limits', 'claude_usage: plan rate limits do not apply', asOfMs);
  if (payload.rate_limits_available !== true) {
    return malformed(`claude_usage: rate_limits_available expected a boolean, got ${describeValue(payload.rate_limits_available)}`);
  }
  const rates = payload.rate_limits;
  if (rates === null || rates === undefined) return unknownRateLimitReading('unavailable', 'claude_usage: the usage endpoint did not answer', asOfMs);
  if (!isObject(rates)) return malformed(`claude_usage: rate_limits expected an object, got ${describeValue(rates)}`);

  const windows: RateLimitReadingWindow[] = [];
  const add = (window: RateLimitReadingWindow): string | undefined => {
    if (windows.length >= MAX_WINDOWS) return `claude_usage: expected at most ${MAX_WINDOWS} windows`;
    // A window at or past its allowance is limited by the provider's own figure.
    const limited = window.usedPercent !== null && window.usedPercent >= 100;
    windows.push(limited ? { ...window, limited: true } : window);
    return undefined;
  };

  for (const [name, value] of Object.entries(rates)) {
    if (name === 'model_scoped' || value === null || value === undefined) continue;
    if (!isUsageWindow(value)) {
      if (CLAUDE_USAGE_DECLARED.has(name)) return malformed(`claude_usage: rate_limits.${name} expected { utilization, resets_at }, got ${describeValue(value)}`);
      continue;
    }
    if (!SAFE_WINDOW_NAME.test(name)) return malformed(unsafeName(`rate_limits key ${windows.length}`, name));
    const read = readUsageWindow(`rate_limits.${name}`, value);
    if (!read.ok) return malformed(read.reason);
    const refused = add({ id: `claude:${name}`, label: name.replaceAll('_', ' '), lengthSeconds: null, usedPercent: read.usedPercent, resetsAtMs: read.resetsAtMs });
    if (refused !== undefined) return malformed(refused);
  }

  const scoped = rates.model_scoped;
  if (scoped !== undefined && scoped !== null) {
    if (!Array.isArray(scoped)) return malformed(`claude_usage: rate_limits.model_scoped expected an array, got ${describeValue(scoped)}`);
    for (const [index, row] of scoped.entries()) {
      const path = `rate_limits.model_scoped[${index}]`;
      if (!isUsageWindow(row) || typeof row.display_name !== 'string') {
        return malformed(`claude_usage: ${path} expected { display_name, utilization, resets_at }, got ${describeValue(isObject(row) ? row.display_name : row)}`);
      }
      const read = readUsageWindow(path, row);
      if (!read.ok) return malformed(read.reason);
      const model = modelLabel(row.display_name);
      const base = `claude:model:${modelSlug(model)}`;
      let id = base;
      for (let n = 2; windows.some((existing) => existing.id === id); n += 1) id = `${base}:${n}`;
      const refused = add({
        id, label: `${model === '' ? 'model' : model} weekly`, lengthSeconds: null, usedPercent: read.usedPercent, resetsAtMs: read.resetsAtMs, scope: { model },
      });
      if (refused !== undefined) return malformed(refused);
    }
  }

  return { state: 'reported', asOfMs, limited: windows.some((window) => window.limited === true), windows, absent: 'not_stated' };
}
