/**
 * The shared plan mapping (G-360 §6), and the two Codex plan bugs it exposed (G-362).
 *
 * Every message these tests produce is checked against the published ACP v1 schema, strictly: a client built from
 * that schema drops a plan entry it cannot read, so "the client did not complain" proves nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_TITLE_MAX,
  PlanProjectionError,
  clientAcceptsPlanUpdates,
  planRemoved,
  planTitle,
  planUpdate,
  type PlanSnapshot,
  type PlanStepState,
} from '../src/plan.js';
import { META_PLAN, META_PLAN_STEP } from '../src/meta.js';
import { sessionUpdateProblems } from './acp-schema.js';

const WITH = { plan: true } as const;
const WITHOUT = { plan: false } as const;

function snapshot(steps: PlanSnapshot['steps'], extra: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return { planId: 'pl_01JPLAN', revision: 3, planStatus: 'active', holdingApprovalId: null, steps, ...extra };
}

const step = (state: PlanStepState, title = `step ${state}`, extra: Record<string, unknown> = {}) =>
  ({ id: `ps_${state}`, title, state, owner: 'agent', approvalId: null, ...extra }) as PlanSnapshot['steps'][number];

type Entry = { content: string; priority: string; status: string; _meta: Record<string, Record<string, unknown>> };

function entries(update: Record<string, unknown>): Entry[] {
  if (update.sessionUpdate === 'plan') return update.entries as Entry[];
  return (update.plan as { entries: Entry[] }).entries;
}

const ALL: readonly PlanStepState[] = ['todo', 'running', 'held', 'waiting_input', 'waiting_condition', 'proposed', 'done', 'failed', 'skipped'];

describe('the client capability', () => {
  it.each([
    [{ plan: {} }, true],
    [{ plan: { _meta: {} } }, true],
    [{ plan: null }, false],
    [{}, false],
    [undefined, false],
    [{ plan: true }, false],
    [{ plan: [] }, false],
    [{ plan: 'yes' }, false],
  ])('reads clientCapabilities %j as plan updates %s', (capabilities, accepts) => {
    // ACP: omitted or null means NOT advertised; `{}` means both update types are accepted. Anything else is not the
    // schema's shape, and a capability is only ever read as present when it is exactly that shape.
    expect(clientAcceptsPlanUpdates(capabilities)).toBe(accepts);
  });
});

describe('planUpdate', () => {
  it.each([WITH, WITHOUT])('every state projects to a schema-valid message (%j)', (client) => {
    const update = planUpdate(snapshot(ALL.map((state) => step(state))), client);
    expect(sessionUpdateProblems(update)).toEqual([]);
  });

  it('sends plan_update keyed by planId only when the client advertised plan', () => {
    const update = planUpdate(snapshot([step('todo')]), WITH);
    expect(update.sessionUpdate).toBe('plan_update');
    expect(update.plan).toMatchObject({ type: 'items', planId: 'pl_01JPLAN' });
    expect(update).not.toHaveProperty('entries');
  });

  it('sends the full-replacement plan when the client did not advertise plan', () => {
    const update = planUpdate(snapshot([step('todo')]), WITHOUT);
    expect(update.sessionUpdate).toBe('plan');
    expect(update).not.toHaveProperty('plan');
    expect(update).not.toHaveProperty('planId');
  });

  it.each([WITH, WITHOUT])('gives every entry the required priority, always medium (%j)', (client) => {
    // Harness has no priority; inventing one would be a claim. The field is required, so it is always present.
    for (const entry of entries(planUpdate(snapshot(ALL.map((state) => step(state))), client))) {
      expect(entry.priority).toBe('medium');
    }
  });

  it.each([
    ['todo', 'pending'],
    ['waiting_input', 'pending'],
    ['waiting_condition', 'pending'],
    ['proposed', 'pending'],
    ['running', 'in_progress'],
    ['held', 'in_progress'],
    ['done', 'completed'],
    ['failed', 'pending'],
    ['skipped', 'pending'],
  ] as const)('maps %s to %s', (state, status) => {
    expect(entries(planUpdate(snapshot([step(state)]), WITHOUT))[0]!.status).toBe(status);
  });

  it.each(['failed', 'skipped'] as const)('shows a %s step unchecked and labelled, NEVER completed', (state) => {
    // ACP's `completed` means "successfully completed"; a failed or skipped step reported that way is a false claim.
    const [entry] = entries(planUpdate(snapshot([step(state, 'Deploy')]), WITH));
    expect(entry!.status).not.toBe('completed');
    expect(entry!.content).toBe(`[${state}] Deploy`);
    expect(entry!._meta[META_PLAN_STEP]).toMatchObject({ id: `ps_${state}`, state });
  });

  it('shows a step a pending change proposes as pending, with its real state and the change\'s approval in _meta', () => {
    // prism-harness (G-360) sends a change's new steps with state `proposed` while the change waits on the person.
    // They are not in the plan yet: never in progress, never completed, and no host label.
    const update = planUpdate(snapshot([step('done', 'Read'), step('proposed', 'Check the totals', { approvalId: 'apr_change' })],
      { planStatus: 'waiting', holdingApprovalId: 'apr_change' }), WITH);
    const [, proposed] = entries(update);
    expect(proposed!.status).toBe('pending');
    expect(proposed!.content).toBe('Check the totals');
    expect(proposed!._meta[META_PLAN_STEP]).toEqual({ id: 'ps_proposed', state: 'proposed', owner: 'agent', approvalId: 'apr_change' });
    expect(sessionUpdateProblems(update)).toEqual([]);
  });

  it('prefixes a person step, after the outcome label', () => {
    const [a, b] = entries(planUpdate(snapshot([step('todo', 'Approve the spend', { owner: 'human' }),
      step('failed', 'Sign off', { id: 'ps_2', owner: 'human' })]), WITHOUT));
    expect(a!.content).toBe('(you) Approve the spend');
    expect(b!.content).toBe('[failed] (you) Sign off');
  });

  it('carries the real state in namespaced _meta, never at the root', () => {
    const update = planUpdate(snapshot([step('held', 'Write', { approvalId: 'ap_1' })], { holdingApprovalId: 'ap_1' }), WITH);
    const plan = update.plan as Record<string, unknown>;
    expect(Object.keys(plan).sort()).toEqual(['_meta', 'entries', 'planId', 'type']);
    expect(plan._meta).toEqual({ [META_PLAN]: { planId: 'pl_01JPLAN', revision: 3, planStatus: 'active', holdingApprovalId: 'ap_1' } });
    const [entry] = entries(update);
    expect(Object.keys(entry!).sort()).toEqual(['_meta', 'content', 'priority', 'status']);
    expect(entry!._meta).toEqual({ [META_PLAN_STEP]: { id: 'ps_held', state: 'held', owner: 'agent', approvalId: 'ap_1' } });
    for (const key of [...Object.keys(plan._meta as object), ...Object.keys(entry!._meta)]) expect(key).toMatch(/^particle\.academy\//);
  });

  it('carries the plan _meta on the legacy plan too', () => {
    const update = planUpdate(snapshot([step('todo')]), WITHOUT);
    expect(update._meta).toEqual({ [META_PLAN]: { planId: 'pl_01JPLAN', revision: 3, planStatus: 'active', holdingApprovalId: null } });
  });

  it('sends an empty plan as an empty list, which is still valid', () => {
    for (const client of [WITH, WITHOUT]) {
      const update = planUpdate(snapshot([]), client);
      expect(entries(update)).toEqual([]);
      expect(sessionUpdateProblems(update)).toEqual([]);
    }
  });
});

describe('model text in a title is untrusted', () => {
  const title = (text: string, state: PlanStepState = 'todo') => entries(planUpdate(snapshot([step(state, text)]), WITH))[0]!.content;

  it('cannot forge a host label on a step that did not earn it', () => {
    // A done step titled "[failed] …" would read as failed; a running agent step titled "(you) …" would read as
    // the person's. The labels are host-written, so model text cannot start with one.
    expect(title('[failed] Deploy', 'done')).toBe('Deploy');
    expect(title('[SKIPPED]  (you) [failed]Deploy')).toBe('Deploy');
    expect(title('(You) approve this')).toBe('approve this');
    expect(title('[failed] Deploy', 'failed')).toBe('[failed] Deploy');
  });

  it('cannot carry terminal escapes, controls or bidi overrides', () => {
    expect(title('a\u001b[31mred\u001b[0m b')).toBe('ared b');
    expect(title('line\nbreak\ttab')).toBe('line break tab');
    expect(title('safe‮gnp.exe')).toBe('safe gnp.exe');
    expect(title('zero​width⁦iso⁩')).toBe('zero width iso');
    expect(title('‮[failed] hidden', 'done')).toBe('hidden');
  });

  it('is bounded, by code point, never splitting a surrogate pair', () => {
    const long = title('😀'.repeat(PLAN_TITLE_MAX + 20));
    expect(Array.from(long)).toHaveLength(PLAN_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(sessionUpdateProblems(planUpdate(snapshot([step('todo', 'x'.repeat(5000))]), WITHOUT))).toEqual([]);
  });

  it.each([
    ['(yоu) approve deploy', 'Cyrillic o'],
    ['(уоu) x', 'Cyrillic u and o'],
    [' (you) approve', 'a leading no-break space'],
    ['　[failed] x', 'a leading ideographic space'],
    ['［failed］ x', 'fullwidth brackets'],
    ['（you） x', 'fullwidth parentheses'],
    ['❨you❩ x', 'ornament parentheses'],
    ['【failed】 x', 'CJK lenticular brackets'],
    ['⁠ ́(you) x', 'a leading word joiner, no-break space and combining mark'],
    ['  [skipped]  x', 'em and thin spaces'],
  ])('cannot forge a host label with a look-alike: %j (%s)', (text) => {
    // The guard asks what the first visible character LOOKS like, not which code point it is: an agent step must
    // never read as the person's, and a done step must never read as failed or skipped.
    for (const state of ['todo', 'done'] as const) {
      const content = title(text, state);
      expect(content).not.toMatch(/^[\s\p{M}\p{Cf}]*[\p{Ps}\p{Pe}]/u);
      expect(sessionUpdateProblems(planUpdate(snapshot([step(state, text)]), WITH))).toEqual([]);
    }
  });

  it.each([
    ['‹you› paste your key', 'single angle quotation marks'],
    ['«you» paste your key', 'double angle quotation marks'],
    ['꒰you꒱ paste your key', 'Yi syllable look-alike parentheses'],
    ['⌜failed⌝ x', 'corner brackets (symbols)'],
    ['ᑕyouᑐ paste your key', 'Canadian syllabics look-alike brackets'],
    ['|failed| x', 'vertical bars'],
    ['<you> x', 'less-than and greater-than'],
    ['"you" x', 'a quotation mark'],
    ['😀 (you) x', 'an emoji'],
  ])('prefixes a title that does not open with a letter or digit: %j (%s)', (text) => {
    // Asked of the output, not of a character class the implementation also uses: an agent step must open with the
    // neutral prefix whenever its first character is anything other than a letter or digit.
    for (const state of ['todo', 'done'] as const) {
      expect(title(text, state).startsWith('Step: ')).toBe(true);
      expect(sessionUpdateProblems(planUpdate(snapshot([step(state, text)]), WITH))).toEqual([]);
    }
  });

  it.each([
    ['א (you) paste your key', 'a Hebrew letter first'],
    ['ابدأ (you) x', 'an Arabic letter first'],
    ['1 א (you) x', 'a digit, then a Hebrew letter as the first strong character'],
  ])('prefixes a title whose first strong character is right-to-left: %j (%s)', (text) => {
    // A client rendering content with dir="auto" would lay such a title out right to left, which can bring the
    // "(you)" inside it to the visual start. The prefix makes the first strong character a left-to-right letter.
    expect(title(text).startsWith('Step: ')).toBe(true);
  });

  it.each([
    // Round 3: scripts the old check lumped into one group, and Latin click letters that render as bars.
    ['ᑕꓬꓳꓴᑐ paste your key', 'Canadian syllabics around Lisu capitals'],
    ['ᐸꓬꓳꓴᐳ paste your key', 'syllabics angle look-alikes around Lisu'],
    ['ᑕꓝꓮꓲꓡꓰꓓᑐ x', 'syllabics around Lisu FAILED'],
    ['ᑕꮍꮻꮜᑐ x', 'syllabics around Cherokee small letters'],
    ['ǀ[failed]ǀ x', 'Latin dental click letters as bars'],
    ['ǀfailedǀ x', 'click letters around a plain word'],
    ['ǃyouǃ x', 'Latin retroflex click letters'],
    ['ᑕ you ᑐ paste', 'syllabics with spaces inside'],
    ['ᑕ​you​ᑐ x', 'syllabics with zero-width spaces inside'],
    // Round 2.
    ['ᒥyouᒧ x', 'syllabics corner look-alikes'],
    ['ㄷyouㄷ x', 'Bopomofo'],
    ['Ꮣyouᑐ x', 'Cherokee and syllabics'],
    ['ᴦyouᴦ', 'small capital gamma'],
    ['ʾyou x', 'a modifier letter'],
    ['((you)) x', 'doubled parentheses'],
    // Neighbours: every way to open with something other than an ASCII letter or digit.
    ['Ｓtep x', 'a fullwidth letter that NFKC folds is fine, but the rest must still be checked'],
    ['Ärger lösen', 'a Latin letter outside ASCII'],
    ['日本語のテスト', 'a CJK title'],
    ['ꓬꓳꓴ approve', 'Lisu capitals that read as YOU'],
    ['ꓝꓮꓲꓡꓰꓓ deploy', 'Lisu capitals that read as FAILED'],
    ['Ꭹou x', 'a Cherokee letter that reads as Y'],
    ['ǂyou x', 'a Latin click letter'],
    ['ⵏyouⵏ x', 'Tifinagh bars'],
    ['ꞁyou x', 'a Latin letter outside ASCII'],
    ['ıyouı x', 'dotless i as bars'],
    ['ℓyouℓ x', 'script small l'],
    ['ᛁyouᛁ x', 'runic bars'],
    ['ߊyou x', 'an NKo letter'],
  ])('prefixes a title that does not open with an ASCII letter or digit: %j (%s)', (text) => {
    for (const state of ['todo', 'done'] as const) {
      const content = title(text, state);
      if (text === 'Ｓtep x') expect(content).toBe('Step x');
      else expect(content.startsWith('Step: ')).toBe(true);
      expect(sessionUpdateProblems(planUpdate(snapshot([step(state, text)]), WITH))).toEqual([]);
    }
    if (text !== 'Ｓtep x') expect(planTitle(text).startsWith('Step: ')).toBe(true);
  });

  it.each([
    ['⁽you⁾', 'Untitled step'],
    ['︵you︶', 'Untitled step'],
    ['﹙you﹚ x', 'x'],
    ['́(you) x', 'x'],
  ])('removes a label that folds to the real one: %j', (text, expected) => {
    // NFKC folds these onto the ASCII label, and a leading combining mark is stripped, so the label itself is removed.
    expect(title(text, 'done')).toBe(expected);
  });

  it.each([
    // An ASCII opening can still be followed by a label in any form: ASCII letters that read as brackets or bars
    // (I, l, C), or a label word spelled with look-alikes. Any such title is prefixed.
    ['I[failed]I x', 'capital I as bars'],
    ['l(you)l x', 'small l as bars'],
    ['CyouↃ x', 'C and a reversed C'],
    ['C ꓬꓳꓴ Ↄ x', 'Lisu inside'],
    ['IfailedI x', 'bars around a plain word'],
    ['I[faiIed]I x', 'capital I for small l'],
    ['I[fai1ed]I x', 'digit 1 for small l'],
    ['I[FAILED]I x', 'capitals'],
    ['I[skipped]I x', 'skipped'],
    ['I[s|<ipped]I x', 'a bar and less-than for k'],
    ['I[failecl]I x', 'cl for d'],
    ['l(y0u)l x', 'zero for o'],
    ['l(yov)l x', 'v for u'],
    ['l(yоu)l x', 'Cyrillic o'],
    ['l(ꓬꓳꓴ)l x', 'Lisu capitals'],
    ['l(𝐲𝐨𝐮)l x', 'mathematical bold letters'],
    ['l(ｙｏｕ)l x', 'fullwidth letters'],
    ['l(ýou)l x', 'a combining mark inside'],
    ['l(yóu)l x', 'a precomposed accent'],
    ['Do what (you) say', 'the label word later in the title'],
    ['Update your config', 'the label word inside another word'],
    ['1 א (you) x', 'a digit, then a Hebrew letter'],
    ['1 (you) x', 'a digit, then a label'],
  ])('prefixes a title that contains a label word in any form: %j (%s)', (text) => {
    for (const state of ['todo', 'done'] as const) expect(title(text, state).startsWith('Step: ')).toBe(true);
  });

  it('leaves a title that opens with an ASCII letter or digit and holds no label word alone', () => {
    expect(title('2 files changed')).toBe('2 files changed');
    expect(title('Deploy א')).toBe('Deploy א');
    expect(title('Run the tests')).toBe('Run the tests');
    expect(title('Lint and type-check')).toBe('Lint and type-check');
    expect(planTitle('Fix the build')).toBe('Fix the build');
  });

  it('keeps an ordinary title, and a host label still leads a labelled step', () => {
    expect(title('Run the tests')).toBe('Run the tests');
    expect(title(' Run　the tests ')).toBe('Run the tests');
    expect(title('［failed］ x', 'done')).toBe('x');
    expect(title(' (you) approve')).toBe('approve');
    expect(title('(optional) lint')).toBe('Step: (optional) lint');
    expect(title('[draft] notes', 'failed')).toBe('[failed] Step: [draft] notes');
    const person = entries(planUpdate(snapshot([step('todo', '(yоu) paste the key', { owner: 'human' })]), WITH))[0]!.content;
    expect(person).toBe('(you) Step: (yоu) paste the key');
  });

  it('never leaves an entry with no text', () => {
    expect(title('')).toBe('Untitled step');
    expect(title('\u0000‮  ')).toBe('Untitled step');
    expect(title('[failed]', 'skipped')).toBe('[skipped] Untitled step');
  });
});

describe('a malformed snapshot fails closed', () => {
  it.each([
    ['an unknown state', snapshot([step('finished' as PlanStepState)])],
    ['a non-string title', snapshot([step('todo', 7 as unknown as string)])],
    ['a step id with a newline', snapshot([step('todo', 't', { id: 'ps_1\n' })])],
    ['an empty plan id', snapshot([], { planId: '' })],
    ['a negative revision', snapshot([], { revision: -1 })],
    ['a fractional revision', snapshot([], { revision: 1.5 })],
    ['an unknown plan status', snapshot([], { planStatus: 'approved' })],
    ['an unknown owner', snapshot([step('todo', 't', { owner: 'model' })])],
    ['a duplicate step id', snapshot([step('todo'), step('todo')])],
    ['more steps than the ceiling', snapshot(Array.from({ length: 51 }, (_, index) => step('todo', 't', { id: `ps_${index}` })))],
  ])('refuses %s rather than guessing', (_label, value) => {
    // A projection that mapped an unknown state to something would have to pick, and every pick is a claim about a
    // step this code knows nothing about.
    for (const client of [WITH, WITHOUT]) expect(() => planUpdate(value, client)).toThrow(PlanProjectionError);
  });
});

describe('planRemoved', () => {
  it('is sent only to a client that advertised plan, and is schema-valid', () => {
    const removed = planRemoved('pl_01JPLAN', WITH);
    expect(removed).toEqual({ sessionUpdate: 'plan_removed', planId: 'pl_01JPLAN' });
    expect(sessionUpdateProblems(removed)).toEqual([]);
  });

  it('is nothing at all for a client that did not', () => {
    expect(planRemoved('pl_01JPLAN', WITHOUT)).toBeNull();
  });

  it('refuses a malformed plan id', () => {
    expect(() => planRemoved('pl\n1', WITH)).toThrow(PlanProjectionError);
  });
});
