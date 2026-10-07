/**
 * The rate-limit payload the Claude CLI reports, declared and narrowed.
 *
 * ## Why a parse and not just an interface
 *
 * This shipped as `input.rate_limit_info ?? input` -- passed through verbatim,
 * with nothing in the `.d.ts` naming a field. A consumer building a headroom
 * gauge then has to guess the provider's field names off a captured frame, and
 * the failure mode when the provider renames one is the worst available: the
 * read yields `undefined`, the gauge renders empty, and a human reads an empty
 * gauge as PLENTY OF HEADROOM. A wrong answer delivered confidently.
 *
 * An interface alone does not fix that. The payload crosses a pipe as JSON, so
 * it arrives as `unknown`, and an interface over `unknown` is a cast: a rename
 * still produces the same silent `undefined`, only now with a type annotation
 * standing behind it. What makes a rename LOUD is {@link parseRateLimit}
 * refusing the shape, so the mapper can emit no gauge at all and say what it
 * actually received instead. Absent and explained beats zero and plausible.
 *
 * ## Where the shape came from
 *
 * Three independently captured turns in `test/fixtures`, which agree on every
 * key. Nothing here is inferred from a schema, because no schema for this frame
 * was available -- the same provenance rule as the rest of this mapper.
 *
 * ## What the captures do NOT tell us
 *
 * Every captured frame says `status: "allowed"`. **No breached frame has ever
 * been captured**, so how a breach is spelled is genuinely unknown, and so are
 * the `overageStatus` values beyond `"rejected"`. Those stay open string unions
 * on purpose -- see {@link ClaudeRateLimit.status}.
 */

/** One rate-limit window, as the provider reports it. */
export interface ClaudeRateLimitWindow {
  /**
   * The fraction of this window consumed -- `0.12` is 12% used.
   *
   * **This can exceed 1.** The frame models overage (`isUsingOverage`,
   * `overageStatus`), so a window consumed past its allowance is a real state
   * and not a corrupt reading. {@link parseRateLimit} therefore accepts any
   * finite value `>= 0` and does NOT cap it at 1: a capped figure would be a
   * number this package made up. Clamp for a progress bar if you like, but
   * clamp at the point of display, where a reader can also see
   * `isUsingOverage`.
   */
  readonly utilization: number;
  /** When this window resets, in epoch MILLISECONDS. See {@link ClaudeRateLimit.resetsAtMs}. */
  readonly resetsAtMs: number;
}

/** The structured rate-limit detail carried under `particle.academy/rate_limit`. */
export interface ClaudeRateLimit {
  /**
   * `"allowed"` in every frame captured so far.
   *
   * The union is OPEN (`'allowed' | (string & {})`) deliberately, which keeps
   * the known literal in autocomplete while accepting any string. A closed
   * union would be the same silent-failure class inverted: it would break a
   * consumer's BUILD the first time a real breach arrived, which is worse than
   * the problem it was guarding against. Test `status !== 'allowed'` for "not
   * allowed"; never match a specific breach spelling, because nobody here has
   * seen one.
   */
  readonly status: 'allowed' | (string & {});
  /**
   * When the binding window resets, in epoch MILLISECONDS.
   *
   * **The provider sends SECONDS**, in a field named `resetsAt` that gives no
   * hint of its unit. This field is named for its unit and converted exactly
   * once, here, because the alternative is every consumer deciding
   * independently and one of them rendering January 1970.
   *
   * No seconds-vs-milliseconds heuristic is applied. A range sniff would
   * silently absorb a unit change by the provider; the conversion is
   * unconditional so `test/rate-limit.test.ts` fails instead -- it pins the
   * captured values to their real dates.
   */
  readonly resetsAtMs: number;
  /** Which window the provider currently treats as binding, e.g. `"five_hour"`. */
  readonly rateLimitType: string;
  /** Open union for the same reason as {@link ClaudeRateLimit.status}: only `"rejected"` has been seen. */
  readonly overageStatus?: string;
  readonly overageDisabledReason?: string;
  readonly isUsingOverage?: boolean;
  /** Every window the frame reported, keyed as the provider keys them (`five_hour`, `seven_day`). */
  readonly windows: Readonly<Record<string, ClaudeRateLimitWindow>>;
  /**
   * The provider's object, verbatim.
   *
   * Kept ON the typed value rather than beside it, so one `_meta` key always
   * carries both views. It covers the case a refusal cannot: a field the
   * provider ADDS still parses, and would otherwise be dropped by a type that
   * does not know about it yet. `src/meta.ts` is explicit that nothing is
   * silently dropped, and a narrowing parse is exactly where that rule would
   * otherwise be quietly broken.
   */
  readonly raw: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number at or above `minimum`, or `undefined`. */
function finite(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Narrow an unknown rate-limit payload, or refuse it.
 *
 * Returns `undefined` rather than a partial value. A partial is the thing worth
 * refusing hardest: a gauge built from half a payload looks like a reading.
 *
 * **One malformed window refuses the WHOLE payload.** Dropping the bad window
 * and keeping the rest would mean a consumer whose `five_hour` figure went
 * malformed silently renders the `seven_day` one in its place -- a healthy
 * number, off the wrong window, with nothing to indicate the substitution.
 */
export function parseRateLimit(value: unknown): ClaudeRateLimit | undefined {
  if (!isObject(value)) return undefined;

  const status = optionalString(value.status);
  const rateLimitType = optionalString(value.rateLimitType);
  const resetsAtSeconds = finite(value.resetsAt, Number.MIN_VALUE);

  if (status === undefined || rateLimitType === undefined || resetsAtSeconds === undefined) {
    return undefined;
  }

  // An absent `unifiedWindows` is refused, not treated as "no windows": it is
  // the only part of this payload that answers "how much is left", so a
  // consumer receiving a typed value without it would have a reset time and no
  // gauge, which is the shape this type exists to stop being ambiguous.
  if (!isObject(value.unifiedWindows)) return undefined;

  const windows: Record<string, ClaudeRateLimitWindow> = {};
  for (const [name, window] of Object.entries(value.unifiedWindows)) {
    if (!isObject(window)) return undefined;

    const utilization = finite(window.utilization, 0);
    const windowResetsAtSeconds = finite(window.resetsAt, Number.MIN_VALUE);
    if (utilization === undefined || windowResetsAtSeconds === undefined) return undefined;

    windows[name] = { utilization, resetsAtMs: windowResetsAtSeconds * 1000 };
  }

  const isUsingOverage =
    typeof value.isUsingOverage === 'boolean' ? value.isUsingOverage : undefined;

  return {
    status,
    resetsAtMs: resetsAtSeconds * 1000,
    rateLimitType,
    ...(optionalString(value.overageStatus) === undefined
      ? {}
      : { overageStatus: value.overageStatus as string }),
    ...(optionalString(value.overageDisabledReason) === undefined
      ? {}
      : { overageDisabledReason: value.overageDisabledReason as string }),
    ...(isUsingOverage === undefined ? {} : { isUsingOverage }),
    windows,
    raw: value,
  };
}

/**
 * The sentence a human reads, built from the figures rather than from nothing.
 *
 * The notice this goes on used to say only "The provider reported a rate
 * limit." -- true, and actionable by no one. The structured half is for a
 * client; this half is for the person watching, and it should carry the two
 * numbers they would otherwise have to open a debugger to see.
 */
export function rateLimitNotice(limit: ClaudeRateLimit): string {
  const binding = limit.windows[limit.rateLimitType];
  const resetsAtMs = binding?.resetsAtMs ?? limit.resetsAtMs;
  const used =
    binding === undefined ? '' : ` at ${Math.round(binding.utilization * 100)}% used`;

  return `Rate limit: ${limit.rateLimitType} window${used}, resets ${new Date(resetsAtMs).toISOString()}.`;
}
