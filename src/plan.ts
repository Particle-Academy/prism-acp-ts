/**
 * An agent plan, as ACP shows it (G-360 §6).
 *
 * A host's plan -- prism-harness's, or any driver's that keeps one -- is projected here into the `session/update` a
 * client can read. Any driver can use it; prism-php's `Prism\Acp\Plan\PlanProjection` is the same mapping, row for row, except
 * that its title label guard is still ASCII-only (the look-alike handling below has not reached it yet).
 *
 * ## The shape depends on the client
 *
 * `plan` is a full replacement of the session's one checklist and every client accepts it. `plan_update` (keyed by
 * `planId`) and `plan_removed` exist only for a client that advertised `clientCapabilities.plan`, and MUST NOT be sent
 * to any other. {@link clientAcceptsPlanUpdates} reads that capability; `AcpAgent` also enforces it on every update a
 * driver sends, so a driver that gets this wrong cannot put the wrong shape on the wire.
 *
 * ## What ACP cannot say, and how it is said instead
 *
 * ACP's statuses are `pending`, `in_progress` and `completed`, where `completed` means "successfully completed". A
 * failed or skipped step is therefore shown UNCHECKED, labelled `[failed]` or `[skipped]`: reporting it as completed
 * would be a false claim, and an unchecked labelled item is the least wrong thing the protocol can carry. The real state
 * rides in `_meta` under our namespace. Every entry's `priority` is `medium`: a plan step has no priority, the field is
 * required, and any other value would be invented.
 *
 * ## Titles are model text
 *
 * A step title was written by a model that may have been steered by something it read. It is cleaned (terminal
 * escapes, controls, invisible and bidi characters become spaces; NFKC folds fullwidth forms; every Unicode space
 * becomes an ASCII one), bounded, and cannot begin with one of the labels this module writes -- otherwise a finished
 * step titled "[failed] ..." would read as failed, and an agent step titled "(you) ..." would read as the person's.
 * A title that still begins with a bracket of any kind (a homoglyph such as "(yоu)" with a Cyrillic о, "❨you❩",
 * "【failed】") is prefixed with "Step: ", so nothing that looks like a label stands where a host label stands.
 *
 * ## A malformed snapshot is refused
 *
 * An unknown state, owner or plan status, a bad id or an oversized plan throws {@link PlanProjectionError}. Mapping
 * an unknown state to anything would be a claim about a step this code knows nothing about.
 */
import type { AcpUpdate } from './claude/to-acp.js';
import { META_PLAN, META_PLAN_STEP } from './meta.js';
import { stripAnsiControlSequences } from './text.js';

/**
 * A step's state, as prism-harness records it (G-360 §1.3). `proposed` is a step a pending change would add: it is not
 * in the plan yet, so it is shown pending, never in progress or completed, with the real state in `_meta`.
 */
export type PlanStepState = 'todo' | 'running' | 'held' | 'waiting_input' | 'waiting_condition' | 'proposed' | 'done' | 'failed' | 'skipped';
/** Who does the step. `human` steps are the person's. */
export type PlanStepOwner = 'agent' | 'human';
/** A plan's status (G-360 §1.1). */
export type PlanStatus = 'proposed' | 'active' | 'waiting' | 'blocked' | 'done' | 'cancelled' | 'rejected';

export interface PlanStep {
  readonly id: string;
  /** Model text. Cleaned and bounded here. */
  readonly title: string;
  readonly state: PlanStepState;
  /** Absent means `agent`. */
  readonly owner?: PlanStepOwner;
  /** The core approval the step is held on, if any. */
  readonly approvalId?: string | null;
}

export interface PlanSnapshot {
  readonly planId: string;
  readonly revision: number;
  readonly planStatus: PlanStatus | string;
  readonly holdingApprovalId?: string | null;
  readonly steps: readonly PlanStep[];
}

/** What the client said it can receive. Build it with {@link clientAcceptsPlanUpdates}. */
export interface PlanClient {
  readonly plan: boolean;
}

/** The longest title shown, in code points, including the `…` that marks a cut. */
export const PLAN_TITLE_MAX = 160;
/** The most steps one plan may carry: prism-harness's operator ceiling (G-360 §8). */
export const PLAN_STEPS_MAX = 50;
/** Every entry's priority. */
export const PLAN_ENTRY_PRIORITY = 'medium';
/** Shown for a title that is empty once cleaned. */
export const PLAN_UNTITLED = 'Untitled step';

export class PlanProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanProjectionError';
  }
}

const STATUS: Readonly<Record<PlanStepState, 'pending' | 'in_progress' | 'completed'>> = Object.freeze({
  todo: 'pending',
  waiting_input: 'pending',
  waiting_condition: 'pending',
  proposed: 'pending',
  running: 'in_progress',
  held: 'in_progress',
  done: 'completed',
  failed: 'pending',
  skipped: 'pending',
});
const PLAN_STATUSES: ReadonlySet<string> = new Set(['proposed', 'active', 'waiting', 'blocked', 'done', 'cancelled', 'rejected']);
const OWNERS: ReadonlySet<string> = new Set(['agent', 'human']);
/** Ids are host-minted (`pl_`/`ps_`/`ap_` + ULID); this is wider than that and still excludes anything that renders. */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/**
 * Replaced by a space in a title: every C0 control (tab and line breaks included -- a title is one line), DEL, C1,
 * every format character (`\p{Cf}`: zero-width marks, bidi embeddings, overrides and isolates, tag characters, BOM),
 * variation selectors, the combining grapheme joiner, Mongolian variation selectors, the braille blank, Hangul fillers,
 * the line/paragraph separators and lone surrogates. PHP's `PlanProjection::HIDDEN` is the same set.
 */
const HIDDEN = /[\u{0000}-\u{001F}\u{007F}-\u{009F}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{034F}\u{180B}-\u{180F}\u{2800}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2028}\u{2029}\u{D800}-\u{DFFF}]/gu;
/** Every Unicode space separator (no-break, ideographic, em, thin, ...). Each becomes an ASCII space. */
const SPACES = /\p{Zs}/gu;
/**
 * What a title may not begin with: the labels this module writes (ASCII, case-insensitive, after NFKC has folded
 * fullwidth forms), and any leading spaces or combining marks. One linear pass: the alternatives start with
 * different characters, so the run cannot backtrack.
 */
const LEADING = /^(?:\[failed\]|\[skipped\]|\(you\)|[ \p{M}])+/iu;
/**
 * What a title may open with and stand unprefixed: a letter that is not a modifier letter (`\p{Lm}` holds quote and
 * prime look-alikes such as U+02BF), or a digit. This is an allow-list on purpose. Asking which characters look like
 * a bracket can never be finished -- `‹you›`, `«you»`, `꒰you꒱` (Yi), `⌜failed⌝` (symbols) all read as a label and none
 * of them is classed as a bracket -- so anything else is prefixed with {@link PLAN_TITLE_NEUTRAL}, at the cost of an
 * occasional `Step: ` before a title that opens with an emoji or a quotation mark.
 */
const OPENS_PLAIN = /^(?:(?!\p{Lm})\p{L}|\p{N})/u;
/**
 * Letters and digits of the right-to-left scripts (bidi classes R and AL: Hebrew, Arabic, Syriac, Thaana, NKo, ...
 * and the supplementary-plane RTL scripts). A title whose first strong character is one of these is laid out right
 * to left by a client that renders it with `dir="auto"`, which can bring a `(you)` inside it to the visual start, so
 * it is prefixed too.
 */
const RTL = /^[\u{0590}-\u{08FF}\u{FB1D}-\u{FDFF}\u{FE70}-\u{FEFF}\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]$/u;
const LETTER = /^\p{L}$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
/**
 * Scripts a first word may not mix. Letters from two of these in the opening word (`ᑕyouᑐ`: Canadian syllabics
 * around Latin) are the look-alike-label shape; a real title's first word is in one script. Han, kana, Hangul and
 * Bopomofo are written together, so they count as one. A letter in none of them counts as one more group.
 */
const SCRIPTS: readonly RegExp[] = [
  /\p{Script=Latin}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Cyrillic}/u,
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u,
];
/** Put before a title whose opening could read as a label; see {@link OPENS_PLAIN}. */
export const PLAN_TITLE_NEUTRAL = 'Step: ';

/**
 * Whether `clientCapabilities` (the client's `initialize` params) advertises plan updates. ACP: omitted or `null`
 * means not advertised; an object (`{}`) means `plan_update` and `plan_removed` may be sent. Anything else is not the
 * schema's shape and reads as not advertised.
 */
export function clientAcceptsPlanUpdates(clientCapabilities: unknown): boolean {
  if (typeof clientCapabilities !== 'object' || clientCapabilities === null || Array.isArray(clientCapabilities)) return false;
  const plan = (clientCapabilities as Record<string, unknown>).plan;
  return typeof plan === 'object' && plan !== null && !Array.isArray(plan);
}

/** The `session/update` that shows this plan: `plan_update` for a client that advertised plan, otherwise `plan`. */
export function planUpdate(snapshot: PlanSnapshot, client: PlanClient): AcpUpdate {
  const planId = checkedId(snapshot.planId, 'planId');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new PlanProjectionError('revision must be a non-negative integer');
  if (typeof snapshot.planStatus !== 'string' || !PLAN_STATUSES.has(snapshot.planStatus)) throw new PlanProjectionError('unknown plan status');
  const holdingApprovalId = optionalId(snapshot.holdingApprovalId, 'holdingApprovalId');
  if (!Array.isArray(snapshot.steps)) throw new PlanProjectionError('steps must be a list');
  if (snapshot.steps.length > PLAN_STEPS_MAX) throw new PlanProjectionError(`a plan carries at most ${PLAN_STEPS_MAX} steps`);

  const seen = new Set<string>();
  const entries = snapshot.steps.map((step) => {
    const entry = planEntry(step);
    const id = (entry._meta[META_PLAN_STEP] as { id: string }).id;
    if (seen.has(id)) throw new PlanProjectionError('duplicate step id');
    seen.add(id);
    return entry;
  });
  const _meta = { [META_PLAN]: { planId, revision: snapshot.revision, planStatus: snapshot.planStatus, holdingApprovalId } };
  return client.plan
    ? { sessionUpdate: 'plan_update', plan: { type: 'items', planId, entries, _meta } }
    : { sessionUpdate: 'plan', entries, _meta };
}

/** `plan_removed` for a client that advertised plan; `null` (send nothing) for one that did not. */
export function planRemoved(planId: string, client: PlanClient): AcpUpdate | null {
  const id = checkedId(planId, 'planId');
  return client.plan ? { sessionUpdate: 'plan_removed', planId: id } : null;
}

/** One ACP `PlanEntry`. */
export function planEntry(step: PlanStep): { content: string; priority: string; status: string; _meta: Record<string, unknown> } {
  if (typeof step !== 'object' || step === null) throw new PlanProjectionError('a step must be an object');
  const id = checkedId(step.id, 'step id');
  if (typeof step.state !== 'string' || !Object.hasOwn(STATUS, step.state)) throw new PlanProjectionError('unknown step state');
  const owner = step.owner ?? 'agent';
  if (typeof owner !== 'string' || !OWNERS.has(owner)) throw new PlanProjectionError('unknown step owner');
  if (typeof step.title !== 'string') throw new PlanProjectionError('a step title must be a string');
  const approvalId = optionalId(step.approvalId, 'approvalId');

  const label = (step.state === 'failed' ? '[failed] ' : step.state === 'skipped' ? '[skipped] ' : '') + (owner === 'human' ? '(you) ' : '');
  return {
    content: label + planTitle(step.title),
    priority: PLAN_ENTRY_PRIORITY,
    status: STATUS[step.state],
    _meta: { [META_PLAN_STEP]: { id, state: step.state, owner, approvalId } },
  };
}

/** A model-written title, made safe to show: one line, nothing hidden, no host label, at most {@link PLAN_TITLE_MAX}. */
export function planTitle(value: string): string {
  // NFKC folds fullwidth and other compatibility forms ("［failed］") onto the ASCII the label check reads. Every
  // Unicode space becomes an ASCII one and runs collapse, so trimming is one character at each end.
  const cleaned = stripAnsiControlSequences(value).text.normalize('NFKC').replace(HIDDEN, ' ').replace(SPACES, ' ').replace(/ {2,}/g, ' ');
  let text = trimSpace(cleaned.replace(LEADING, ''));
  // Whatever is left may still LOOK like a label ("(yоu)" with a Cyrillic о, "‹you›", "꒰you꒱", "ᑕyouᑐ"). The question
  // is what the opening looks like, not which code point it is, so only a plain opening stands unprefixed.
  if (text !== '' && opensLikeLabel(text)) text = PLAN_TITLE_NEUTRAL + text;
  const points = Array.from(text);
  if (points.length > PLAN_TITLE_MAX) text = trimSpace(points.slice(0, PLAN_TITLE_MAX - 1).join('')) + '…';
  return text === '' ? PLAN_UNTITLED : text;
}

/**
 * Whether a cleaned title must be prefixed: it opens with anything but a letter or digit, its first strong character
 * is right-to-left, or its first word mixes scripts.
 */
function opensLikeLabel(text: string): boolean {
  if (!OPENS_PLAIN.test(text)) return true;
  for (const point of text) {
    if (LETTER_OR_DIGIT.test(point) && RTL.test(point)) return true;
    if (LETTER.test(point)) break;
  }
  const groups = new Set<number>();
  for (const point of text.split(' ', 1)[0]!) {
    if (!LETTER.test(point)) continue;
    groups.add(SCRIPTS.findIndex((script) => script.test(point)));
    if (groups.size > 1) return true;
  }
  return false;
}

/** Remove one space from each end. Callers have already collapsed runs of spaces, so one is all there can be. */
function trimSpace(text: string): string {
  const start = text.startsWith(' ') ? 1 : 0;
  const end = text.endsWith(' ') && text.length > start ? text.length - 1 : text.length;
  return text.slice(start, end);
}

function checkedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new PlanProjectionError(`${name} is not a valid id`);
  return value;
}

function optionalId(value: unknown, name: string): string | null {
  return value === undefined || value === null ? null : checkedId(value, name);
}
