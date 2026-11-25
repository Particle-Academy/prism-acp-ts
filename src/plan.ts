/**
 * An agent plan, as ACP shows it (G-360 §6).
 *
 * A host's plan -- prism-harness's, or any driver's that keeps one -- is projected here into the `session/update` a
 * client can read. Any driver can use it; prism-php's `Prism\Acp\Plan\PlanProjection` is the same mapping, row for row, except
 * for titles: it still leaves some unprefixed behind an ASCII look-alike check, where this module prefixes every one.
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
 * becomes an ASCII one) and bounded. A finished step titled "[failed] ..." must not read as failed, and an agent step
 * titled "(you) ..." must not read as the person's, so the rule is structural rather than a list of look-alikes: an
 * entry's text is the host's own labels (`[failed] `, `[skipped] `, `(you) `, written only from the step's state and
 * owner), then {@link PLAN_TITLE_NEUTRAL}, then the model's title. Model text therefore never stands where a label
 * stands, whatever it spells. The only entry text without the prefix is the host's {@link PLAN_UNTITLED}.
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
/**
 * The longest plan entry `content` `AcpAgent` sends, in code points. A longer one refuses the whole update, and that
 * is reported. Room for the host's labels and a {@link PLAN_TITLE_MAX} title many times over; a step is one line.
 */
export const PLAN_ENTRY_CONTENT_MAX = 1024;
/**
 * The largest `_meta` `AcpAgent` sends on a plan update or one of its entries, in UTF-8 bytes of its JSON. A larger
 * one refuses the whole update, and that is reported.
 */
export const PLAN_META_MAX_BYTES = 16384;
/**
 * The most entries `AcpAgent` sends in one plan update. More refuses the whole update, and that is reported. Above
 * {@link PLAN_STEPS_MAX} on purpose: that is the harness's ceiling for plans it builds, this is the gate's ceiling for
 * whatever a driver hands it, including a model-written Codex plan.
 */
export const PLAN_ENTRIES_MAX = 256;
/** The longest markdown plan `content` `AcpAgent` sends, in code points. Longer refuses the update, and that is reported. */
export const PLAN_MARKDOWN_MAX = 65536;
/** The longest markdown plan `path`, and the longest `planId`, `AcpAgent` sends, in code points. */
export const PLAN_PATH_MAX = 4096;
export const PLAN_ID_MAX = 256;

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
/** Whether text holds a character {@link HIDDEN} names: a control, format, invisible or lone-surrogate character. */
export function holdsHiddenCharacter(value: string): boolean {
  return new RegExp(HIDDEN.source, 'u').test(value);
}
/** Every Unicode space separator (no-break, ideographic, em, thin, ...). Each becomes an ASCII space. */
const SPACES = /\p{Zs}/gu;
/** Spaces and combining marks a cleaned title may not begin with; they are removed. */
const LEADING = /^[ \p{M}]+/u;
/**
 * Put before every model-written title, so the text at the start of an entry is always the host's: its labels, then
 * this. Counted in {@link PLAN_TITLE_MAX}.
 */
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

  // The host's labels, from the step's state and owner and nothing else; the model's title follows, always prefixed.
  const label = (step.state === 'failed' ? '[failed] ' : step.state === 'skipped' ? '[skipped] ' : '') + (owner === 'human' ? '(you) ' : '');
  return {
    content: label + planTitle(step.title),
    priority: PLAN_ENTRY_PRIORITY,
    status: STATUS[step.state],
    _meta: { [META_PLAN_STEP]: { id, state: step.state, owner, approvalId } },
  };
}

/**
 * A model-written title, made safe to show: one line, nothing hidden, always opening with {@link PLAN_TITLE_NEUTRAL},
 * at most {@link PLAN_TITLE_MAX} code points with the prefix. A title that cleans down to nothing is the host's
 * {@link PLAN_UNTITLED}.
 */
export function planTitle(value: string): string {
  // NFKC folds fullwidth and other compatibility forms onto ASCII, so what is shown is what a reader sees. Every
  // Unicode space becomes an ASCII one and runs collapse, so trimming is one character at each end.
  const cleaned = stripAnsiControlSequences(value).text.normalize('NFKC').replace(HIDDEN, ' ').replace(SPACES, ' ').replace(/ {2,}/g, ' ');
  const title = trimSpace(cleaned.replace(LEADING, ''));
  if (title === '') return PLAN_UNTITLED;
  // Always prefixed: the start of an entry belongs to the host, so no spelling of the title can take a label's place.
  const text = PLAN_TITLE_NEUTRAL + title;
  const points = Array.from(text);
  return points.length > PLAN_TITLE_MAX ? trimSpace(points.slice(0, PLAN_TITLE_MAX - 1).join('')) + '…' : text;
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
