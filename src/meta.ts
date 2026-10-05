/**
 * Where a value goes when ACP has no field for it.
 *
 * This module is a DECISION, written down, because the alternative is each
 * mapping site deciding separately and three of them deciding differently.
 *
 * ## The rule
 *
 * An ACP field carries only what matches its semantics. Anything else rides in
 * `_meta` under our namespace. **Nothing is silently dropped.**
 *
 * The spec forces half of this and we chose the other half. ACP is explicit
 * that an implementation *"MUST NOT add any custom fields at the root of a type
 * that's part of the specification"* -- every root name is reserved for future
 * protocol versions -- so a non-ACP value cannot be smuggled in beside the real
 * ones. `_meta` is the sanctioned extension slot, allowed on requests,
 * responses, notifications, content blocks and tool calls, with namespaced keys
 * by convention (`zed.dev/debugMode`).
 *
 * What we chose is the part that matters: **a value whose meaning differs from
 * a field's meaning does not go in that field**, even when the types line up.
 * The temptation runs the other way, because putting a number in a number field
 * always looks like a mapping and never looks like a loss.
 *
 * ## The three frames this exists for
 *
 * The Claude CLI emits three things ACP has no home for. Each was a decision,
 * and the reasoning is kept because the wrong choice is plausible in all three.
 *
 * **`signature_delta` -- PRESERVED, and this is the important one.** It is the
 * integrity signature on a thinking block. Dropping it is the easy default: an
 * exhaustive switch over content-block deltas that simply has no case for it
 * looks complete, passes review, and quietly makes every thinking block
 * unverifiable. A mapping can be structurally correct and still destroy the
 * thing a field exists for.
 *
 * **`system/thinking_tokens` -- NOT merged into `usage_update`.** It is an
 * ESTIMATE (`estimated_tokens`, `estimated_tokens_delta`) and `usage_update`
 * reports measured usage. The types are both numbers, which is exactly why this
 * needed deciding rather than doing: a consumer summing estimates alongside
 * measurements gets a figure that is wrong in a way nothing reveals. Same
 * family as reporting `[]` when the truth is `null` -- a confident answer in
 * place of an honest one.
 *
 * **`rate_limit_event` -- a `notice` AND `_meta`.** Being rate-limited is
 * genuinely user-facing, so it earns a notice a human can read; the structured
 * detail also rides in `_meta` so a client can act on it rather than regex a
 * sentence.
 */

/**
 * Our `_meta` namespace.
 *
 * Domain-shaped, following the convention the spec's own examples use, so a key
 * of ours can never collide with a key of theirs or a future protocol field.
 */
export const META_NS = 'particle.academy';

/**
 * Keys ACP reserves at the root of `_meta` for W3C trace context.
 *
 * Listed so {@link metaKey} can refuse to shadow one. Nothing here namespaces
 * these, which is precisely why a careless `_meta` writer could stamp on them.
 */
export const RESERVED_META_KEYS: readonly string[] = ['traceparent', 'tracestate', 'baggage'];

/** Build a namespaced `_meta` key. */
export function metaKey(name: string): string {
  if (name.length === 0) throw new Error('meta key name must not be empty');
  if (name.includes('/')) {
    throw new Error(`meta key name must not contain '/': ${name}`);
  }
  if (RESERVED_META_KEYS.includes(name)) {
    // Reachable only by passing a bare reserved name, which is a mistake worth
    // an error rather than a namespaced key that merely looks fine.
    throw new Error(`'${name}' is reserved by ACP for W3C trace context`);
  }
  return `${META_NS}/${name}`;
}

/** The integrity signature of a thinking block. Preserved, never dropped. */
export const META_THINKING_SIGNATURE = metaKey('thinking_signature');

/** An ESTIMATE of thinking tokens. Deliberately not merged into measured usage. */
export const META_THINKING_TOKENS_ESTIMATE = metaKey('thinking_tokens_estimate');

/** Structured rate-limit detail, alongside the human-readable notice. */
export const META_RATE_LIMIT = metaKey('rate_limit');

/** The CLI frame a mapping could not place, kept so nothing is lost unseen. */
export const META_UNMAPPED_FRAME = metaKey('unmapped_frame');

/**
 * Attach `_meta` entries to an ACP object without disturbing its own fields.
 *
 * Returns a new object; the input is not mutated. Existing `_meta` is merged
 * rather than replaced, because two mapping sites can both have something to
 * say about one notification and the second must not erase the first -- the
 * same collision that cost `tynn` a permanently parked agent when a second
 * permission overwrote a first.
 */
export function withMeta<T extends object>(
  value: T,
  entries: Readonly<Record<string, unknown>>,
): T & { _meta: Record<string, unknown> } {
  const existing = (value as { _meta?: Record<string, unknown> })._meta ?? {};
  return { ...value, _meta: { ...existing, ...entries } };
}
