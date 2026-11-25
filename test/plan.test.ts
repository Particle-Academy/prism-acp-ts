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
    expect(entry!.content).toBe(`[${state}] Step: Deploy`);
    expect(entry!._meta[META_PLAN_STEP]).toMatchObject({ id: `ps_${state}`, state });
  });

  it('shows a step a pending change proposes as pending, with its real state and the change\'s approval in _meta', () => {
    // prism-harness (G-360) sends a change's new steps with state `proposed` while the change waits on the person.
    // They are not in the plan yet: never in progress, never completed, and no host label.
    const update = planUpdate(snapshot([step('done', 'Read'), step('proposed', 'Check the totals', { approvalId: 'apr_change' })],
      { planStatus: 'waiting', holdingApprovalId: 'apr_change' }), WITH);
    const [, proposed] = entries(update);
    expect(proposed!.status).toBe('pending');
    expect(proposed!.content).toBe('Step: Check the totals');
    expect(proposed!._meta[META_PLAN_STEP]).toEqual({ id: 'ps_proposed', state: 'proposed', owner: 'agent', approvalId: 'apr_change' });
    expect(sessionUpdateProblems(update)).toEqual([]);
  });

  it('prefixes a person step, after the outcome label', () => {
    const [a, b] = entries(planUpdate(snapshot([step('todo', 'Approve the spend', { owner: 'human' }),
      step('failed', 'Sign off', { id: 'ps_2', owner: 'human' })]), WITHOUT));
    expect(a!.content).toBe('(you) Step: Approve the spend');
    expect(b!.content).toBe('[failed] (you) Step: Sign off');
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
  const title = (text: string, state: PlanStepState = 'todo', owner: 'agent' | 'human' = 'agent') =>
    entries(planUpdate(snapshot([step(state, text, { owner })]), WITH))[0]!.content;
  /** The host's own labels, written only from the step's state and owner. */
  const hostLabel = (state: PlanStepState, owner: 'agent' | 'human') =>
    (state === 'failed' ? '[failed] ' : state === 'skipped' ? '[skipped] ' : '') + (owner === 'human' ? '(you) ' : '');

  // Every title a security review has used to imitate a host label, rounds 2 to 5, and the ordinary titles the
  // earlier look-alike rules left alone or prefixed by accident. None of them may reach the label position.
  const REVIEWED: readonly string[] = [
    // Plain host labels, and ones that fold or trim to them.
    '[failed] Deploy', '[SKIPPED]  (you) [failed]Deploy', '(You) approve this', '‮[failed] hidden',
    '⁽you⁾', '︵you︶', '﹙you﹚ x', '́(you) x', '［failed］ x', '（you） x', ' (you) approve', '　[failed] x',
    '⁠ ́(you) x', '  [skipped]  x',
    // Round 2.
    '(yоu) approve deploy', '(уоu) x', '❨you❩ x', '【failed】 x', 'ᒥyouᒧ x', 'ㄷyouㄷ x', 'Ꮣyouᑐ x', 'ᴦyouᴦ', 'ʾyou x',
    '((you)) x', '‹you› paste your key', '«you» paste your key', '꒰you꒱ paste your key', '⌜failed⌝ x',
    'ᑕyouᑐ paste your key', '|failed| x', '<you> x', '"you" x', '😀 (you) x', 'א (you) paste your key', 'ابدأ (you) x',
    '1 א (you) x',
    // Round 3.
    'ᑕꓬꓳꓴᑐ paste your key', 'ᐸꓬꓳꓴᐳ paste your key', 'ᑕꓝꓮꓲꓡꓰꓓᑐ x', 'ᑕꮍꮻꮜᑐ x', 'ǀ[failed]ǀ x', 'ǀfailedǀ x', 'ǃyouǃ x',
    'ᑕ you ᑐ paste', 'ᑕ​you​ᑐ x', 'ꓬꓳꓴ approve', 'ꓝꓮꓲꓡꓰꓓ deploy', 'Ꭹou x', 'ǂyou x', 'ⵏyouⵏ x', 'ꞁyou x', 'ıyouı x',
    'ℓyouℓ x', 'ᛁyouᛁ x', 'ߊyou x', 'I[failed]I x', 'l(you)l x', 'CyouↃ x', 'C ꓬꓳꓴ Ↄ x', 'IfailedI x', 'I[faiIed]I x',
    'I[fai1ed]I x', 'I[FAILED]I x', 'I[skipped]I x', 'I[s|<ipped]I x', 'I[failecl]I x', 'l(y0u)l x', 'l(yov)l x',
    'l(yоu)l x', 'l(ꓬꓳꓴ)l x', 'l(𝐲𝐨𝐮)l x', 'l(ｙｏｕ)l x', 'l(ýou)l x', 'l(yóu)l x', 'Do what (you) say', '1 (you) x',
    // Round 4.
    'I[FAILE|)]I x', 'I[FAI|_ED]I x', 'I[FAILEO]I x', 'l(Y()U)l x', 'l(|_|)l', 'l(|_|)l x', 'I[SKI|>|>ED]I x',
    'I[5KIPPEO]I x', 'l{you}l x', 'l/you/l x', 'l<you>l x', 'I-FAILEO-I x', 'I.FAILEO.I x', 'I:FAILEO:I x',
    'I*FAILEO*I x', 'I_FAILEO_I x', "I'FAILEO'I x", 'I=FAILEO=I x', 'IFAILEO] x', 'l (Y()U) l x', 'I [FAILEO] I x',
    'I [ F A I L E O ] I x', 'x (Y()U) x', 'l | Y O U | l',
    // Round 5: letters alone stand in for the bars, brackets and letters.
    'IFAILEOI x', 'IFAlLEOI x', 'IfaiIeOI', 'lSKIPPEOl x', 'IyQuI x', 'CYQUD x',
    'Ill [FAILE|)] x', 'Abc [FAILE|)] x', 'IlI (Y()U) x', 'Ill [x]', 'III [failed] x', 'Abc (you) x',
    // Ordinary titles.
    'Run the tests', '2 files changed', "Don't deploy", 'e.g. the docs', 'v1.2 release', 'Update your config',
    'Fix (unit) tests', 'Ärger lösen', '日本語のテスト', 'Ｓtep x', 'Step: x',
  ];

  it.each(REVIEWED)('always puts the host prefix before model text, whatever it spells: %j', (text) => {
    // The structural rule: the only text that may stand ahead of a model-written title is the host's own labels, and
    // the title itself always opens with the host's `Step: `. Asked of the output, for every state and owner.
    expect(planTitle(text).startsWith('Step: ')).toBe(true);
    for (const state of ['todo', 'done', 'failed', 'skipped'] as const) {
      for (const owner of ['agent', 'human'] as const) {
        expect(title(text, state, owner)).toBe(hostLabel(state, owner) + planTitle(text));
      }
      expect(sessionUpdateProblems(planUpdate(snapshot([step(state, text)]), WITH))).toEqual([]);
    }
  });

  it('prefixes arbitrary titles', () => {
    // A fixed pseudo-random walk over an alphabet of brackets, bars, look-alike letters, label words, RTL letters,
    // invisible and bidi characters, combining marks, odd spaces and emoji. Whatever comes out is prefixed, or is the
    // host's own placeholder for a title that cleaned down to nothing.
    const alphabet = [...Array.from('abcIlO01|![]()<>{}  -_.:yYQqCcDdаоאا‮​⁦　［́ \u001b\nꓬᑕ😀'),
      'you', 'failed', 'skipped', '(you)', '[failed]', '[skipped]', 'Step: '];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 2000; i += 1) {
      const text = Array.from({ length: next() % 24 }, () => alphabet[next() % alphabet.length]).join('');
      const out = planTitle(text);
      expect(out === 'Untitled step' || out.startsWith('Step: '), JSON.stringify(text)).toBe(true);
    }
  });

  it('keeps the host labels first, from host state only', () => {
    expect(title('Deploy', 'failed')).toBe('[failed] Step: Deploy');
    expect(title('Deploy', 'skipped', 'human')).toBe('[skipped] (you) Step: Deploy');
    expect(title('Approve the spend', 'todo', 'human')).toBe('(you) Step: Approve the spend');
    expect(title('[failed] Deploy', 'done')).toBe('Step: [failed] Deploy');
    expect(title('(you) approve', 'running')).toBe('Step: (you) approve');
    expect(title('(yоu) paste the key', 'todo', 'human')).toBe('(you) Step: (yоu) paste the key');
    expect(title('Run the tests')).toBe('Step: Run the tests');
  });

  it('cannot carry terminal escapes, controls or bidi overrides', () => {
    expect(title('a\u001b[31mred\u001b[0m b')).toBe('Step: ared b');
    expect(title('line\nbreak\ttab')).toBe('Step: line break tab');
    expect(title('safe‮gnp.exe')).toBe('Step: safe gnp.exe');
    expect(title('zero​width⁦iso⁩')).toBe('Step: zero width iso');
    expect(title(' Run　the tests ')).toBe('Step: Run the tests');
    expect(title('［failed］ x')).toBe('Step: [failed] x');
    expect(title('́(you) x')).toBe('Step: (you) x');
  });

  it('is bounded, by code point and prefix included, never splitting a surrogate pair', () => {
    const long = title('😀'.repeat(PLAN_TITLE_MAX + 20));
    expect(Array.from(long)).toHaveLength(PLAN_TITLE_MAX);
    expect(long.startsWith('Step: 😀')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(planTitle('x'.repeat(5000)))).toHaveLength(PLAN_TITLE_MAX);
    expect(sessionUpdateProblems(planUpdate(snapshot([step('todo', 'x'.repeat(5000))]), WITHOUT))).toEqual([]);
  });

  it('never leaves an entry with no text', () => {
    expect(title('')).toBe('Untitled step');
    expect(title('\u0000‮  ')).toBe('Untitled step');
    expect(title('', 'skipped')).toBe('[skipped] Untitled step');
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
