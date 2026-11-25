import type { PermissionOutcome, PermissionRequest } from './acp/agent.js';

/**
 * THE PERMISSION DECISION RULE, for the Claude driver and for any driver written outside this package.
 *
 * The Codex driver does not use it. Codex offers its own options per request (including "Allow for this session",
 * kind `allow_always`) and keeps an exact-id map from each offered option to the answer Codex expects
 * (`codexDecision` in codex/driver.ts). That map also fails closed on any id it did not offer. This rule denies
 * `allow_always`, so a driver that offers allow-for-session options and decides with this rule never allows on them.
 *
 * A tool call is allowed by exactly one answer: the client selected an option that the request OFFERED, named by an
 * id that matches one offered option exactly, whose kind is `allow_once`. Everything else denies: an option that was
 * not offered, a look-alike id (case, padding, invisible or homoglyph characters -- the match is exact, so none of
 * them is normalised into an allow), an id offered twice, `allow_always`, a cancel, a malformed answer, a client that
 * errored, and a client that could not be asked.
 *
 * It is exported so a driver does not copy it. A copied rule is a rule that drifts, and the copy is the one nobody
 * tests.
 */

/** What a driver acts on. `reason` is what the agent is told; it never changes `allow`. */
export interface PermissionDecision {
  readonly allow: boolean;
  readonly reason: string;
}

/** The options the shipped drivers offer: Allow once and Deny. Frozen, so no driver can widen them for another. */
export const ALLOW_ONCE_OR_DENY: readonly Readonly<Record<string, unknown>>[] = Object.freeze([
  Object.freeze({ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }),
  Object.freeze({ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }),
]);

const NO_VALID_ANSWER = 'No valid approval was received.';
const NOT_OFFERED = 'The answer named an option that was not offered.';
const NO_ONE_TO_ASK = 'No one could be asked to approve this tool call.';

/**
 * Decide a permission request from the client's answer. `offered` is the request (or its `options`) exactly as it was
 * sent; `outcome` is whatever came back, unchecked -- pass a thrown error or `null` as it is, and it denies.
 *
 * The client's `reason` is used when the answer itself was valid (an allow, a reject, a cancel), because the decision
 * may not be the person's and the agent should be told the truth. It is ignored for an answer that was not accepted.
 */
export function permissionDecision(
  offered: PermissionRequest | readonly Readonly<Record<string, unknown>>[],
  outcome: unknown,
): PermissionDecision {
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) return deny(NO_VALID_ANSWER);
  const answer = outcome as Record<string, unknown>;
  // Each field read once, so an answer cannot say one thing to the check and another to the decision.
  const kind = answer.outcome;
  const optionId = answer.optionId;
  const rawReason = answer.reason;
  const given = typeof rawReason === 'string' && rawReason !== '' ? rawReason : undefined;

  if (kind === 'cancelled') return deny(given ?? 'The request was cancelled.');
  if (kind !== 'selected' || typeof optionId !== 'string') return deny(NO_VALID_ANSWER);

  const options = Array.isArray(offered) ? offered : (offered as PermissionRequest | null | undefined)?.options;
  if (!Array.isArray(options)) return deny(NOT_OFFERED);
  const matches = options.filter((option): option is Readonly<Record<string, unknown>> =>
    typeof option === 'object' && option !== null && option.optionId === optionId);
  // Not offered, or offered twice (ambiguous: which one did the client mean?).
  if (matches.length !== 1) return deny(NOT_OFFERED);
  if (matches[0]!.kind === 'allow_once') return { allow: true, reason: given ?? 'Allowed by the person.' };
  return deny(given ?? 'The person denied this tool call.');
}

/**
 * Ask the client and decide. A missing client, one that throws, and one whose promise rejects all deny. No timeout is
 * applied here: a driver that needs one races this promise and treats its own expiry as a denial.
 */
export async function askPermission(
  ask: ((request: PermissionRequest) => Promise<PermissionOutcome>) | undefined,
  request: PermissionRequest,
): Promise<PermissionDecision> {
  if (typeof ask !== 'function') return deny(NO_ONE_TO_ASK);
  let outcome: unknown;
  try {
    outcome = await ask(request);
  } catch {
    outcome = null;
  }
  return permissionDecision(request, outcome);
}

function deny(reason: string): PermissionDecision {
  return { allow: false, reason };
}
