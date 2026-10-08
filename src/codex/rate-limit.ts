/** Codex's percentage-based rate-limit window. */
export interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  /** Epoch milliseconds, converted from Codex's epoch-second `resetsAt`. */
  readonly resetsAtMs: number;
}

export interface CodexRateLimit {
  readonly ordinaryUsageAllowed: boolean | null;
  readonly planType?: string;
  readonly primary: CodexRateLimitWindow | null;
  readonly secondary: CodexRateLimitWindow | null;
  readonly credits?: {
    readonly hasCredits: boolean;
    readonly unlimited: boolean;
    readonly balance: number | null;
  };
  readonly spendControlReached?: boolean | null;
  readonly rateLimitReachedType?: string | null;
  readonly availableResetCredits?: number;
}

export type CodexRateLimitRead =
  | { readonly ok: true; readonly limit: CodexRateLimit }
  | { readonly ok: false; readonly reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value === 'object' ? 'object' : typeof value;
}

function refuse(path: string, expected: string, got: unknown): CodexRateLimitRead {
  return { ok: false, reason: `codex_rate_limit: ${path} expected ${expected}, got ${describe(got)}` };
}

function finite(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

function readWindow(value: unknown, path: string): CodexRateLimitRead | CodexRateLimitWindow | null {
  if (value === null) return null;
  if (!isObject(value)) return refuse(path, 'an object or null', value);
  if (!finite(value.usedPercent, 0)) {
    return refuse(`${path}.usedPercent`, 'finite number >= 0', value.usedPercent);
  }
  const windowDurationMins = value.windowDurationMins;
  if (typeof windowDurationMins !== 'number' || !Number.isSafeInteger(windowDurationMins) || windowDurationMins < 1) {
    return refuse(`${path}.windowDurationMins`, 'safe integer >= 1', value.windowDurationMins);
  }
  if (!finite(value.resetsAt, Number.MIN_VALUE)) {
    return refuse(`${path}.resetsAt`, 'finite number > 0 (epoch seconds)', value.resetsAt);
  }
  const resetsAtMs = value.resetsAt * 1000;
  if (!Number.isFinite(resetsAtMs) || resetsAtMs > 8.64e15) {
    return refuse(`${path}.resetsAt`, 'valid epoch seconds representable as a JavaScript date', value.resetsAt);
  }
  return {
    usedPercent: value.usedPercent,
    windowDurationMins,
    resetsAtMs,
  };
}

/** Read the allow-listed rate-limit fields; identifiers and unknown fields never pass through. */
export function readCodexRateLimit(value: unknown): CodexRateLimitRead {
  if (!isObject(value)) return refuse('payload', 'an object', value);
  const outer = value;
  const rates = isObject(value.rateLimits) ? value.rateLimits : value;
  const ordinaryUsageAllowed = outer.ordinaryUsageAllowed ?? rates.ordinaryUsageAllowed ?? null;
  if (ordinaryUsageAllowed !== null && typeof ordinaryUsageAllowed !== 'boolean') {
    return refuse('ordinaryUsageAllowed', 'boolean or null', ordinaryUsageAllowed);
  }

  const primary = readWindow(rates.primary, 'rateLimits.primary');
  if (primary !== null && 'ok' in primary && primary.ok === false) return primary;
  const secondary = readWindow(rates.secondary, 'rateLimits.secondary');
  if (secondary !== null && 'ok' in secondary && secondary.ok === false) return secondary;

  let credits: CodexRateLimit['credits'];
  if (rates.credits !== undefined && rates.credits !== null) {
    if (!isObject(rates.credits)) return refuse('rateLimits.credits', 'an object or null', rates.credits);
    const { hasCredits, unlimited, balance } = rates.credits;
    if (typeof hasCredits !== 'boolean') {
      return refuse('rateLimits.credits.hasCredits', 'boolean', hasCredits);
    }
    if (typeof unlimited !== 'boolean') {
      return refuse('rateLimits.credits.unlimited', 'boolean', unlimited);
    }
    if (balance !== undefined && balance !== null && !finite(balance, 0)) {
      return refuse('rateLimits.credits.balance', 'finite number >= 0 or null', balance);
    }
    credits = { hasCredits, unlimited, balance: typeof balance === 'number' ? balance : null };
  }

  if (rates.planType !== undefined && typeof rates.planType !== 'string') {
    return refuse('rateLimits.planType', 'string', rates.planType);
  }
  const planType = typeof rates.planType === 'string' ? rates.planType : undefined;
  if (
    rates.spendControlReached !== undefined &&
    rates.spendControlReached !== null &&
    typeof rates.spendControlReached !== 'boolean'
  ) {
    return refuse('rateLimits.spendControlReached', 'boolean or null', rates.spendControlReached);
  }
  const spendControlReached =
    typeof rates.spendControlReached === 'boolean' || rates.spendControlReached === null
      ? rates.spendControlReached
      : undefined;
  if (
    rates.rateLimitReachedType !== undefined &&
    rates.rateLimitReachedType !== null &&
    typeof rates.rateLimitReachedType !== 'string'
  ) {
    return refuse('rateLimits.rateLimitReachedType', 'string or null', rates.rateLimitReachedType);
  }
  const rateLimitReachedType =
    typeof rates.rateLimitReachedType === 'string' || rates.rateLimitReachedType === null
      ? rates.rateLimitReachedType
      : undefined;
  const resetCredits = isObject(outer.rateLimitResetCredits)
    ? outer.rateLimitResetCredits.availableCount
    : undefined;
  if (resetCredits !== undefined && (!Number.isSafeInteger(resetCredits) || (resetCredits as number) < 0)) {
    return refuse('rateLimitResetCredits.availableCount', 'integer >= 0', resetCredits);
  }

  return {
    ok: true,
    limit: {
      ordinaryUsageAllowed: ordinaryUsageAllowed as boolean | null,
      ...(planType === undefined ? {} : { planType }),
      primary: primary as CodexRateLimitWindow | null,
      secondary: secondary as CodexRateLimitWindow | null,
      ...(credits === undefined ? {} : { credits }),
      ...(spendControlReached === undefined ? {} : { spendControlReached }),
      ...(rateLimitReachedType === undefined ? {} : { rateLimitReachedType }),
      ...(resetCredits === undefined ? {} : { availableResetCredits: resetCredits as number }),
    },
  };
}

export function parseCodexRateLimit(value: unknown): CodexRateLimit | undefined {
  const result = readCodexRateLimit(value);
  return result.ok ? result.limit : undefined;
}

export function codexRateLimitNotice(limit: CodexRateLimit): string {
  const window = limit.primary;
  if (window === null) return 'Codex rate limit usage is unavailable.';
  return `Codex rate limit: ${window.usedPercent}% used in ${window.windowDurationMins} minutes, resets ${new Date(window.resetsAtMs).toISOString()}.`;
}
