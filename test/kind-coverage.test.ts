/**
 * How much of ACP's `session/update` surface this mapper actually covers.
 *
 * This file exists because of a question from the team building the ACP CLIENT
 * on the other side, and it is a better question than the one it answers:
 *
 *   > My switch covers the 19 kinds from the schema, so the interesting answer
 *   > won't be "which did my switch reject" -- it'll be WHICH OF THE 19 YOUR
 *   > CAPTURE NEVER PRODUCED. A kind I handle that no real agent emits is dead
 *   > code wearing coverage.
 *
 * Both directions are checked here, and the honest answer is uncomfortable:
 * **this mapper emits 7 of 19.** The seven are not "the kinds that exist" --
 * they are the shadow of the turns that happened to be captured. Writing that
 * down as a test rather than a sentence is the difference between a known gap
 * and a surprise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { NdjsonFramer } from '../src/ndjson.js';

/** Every `sessionUpdate` discriminator ACP defines. */
const ACP_KINDS = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
  'subagent_update',
  'session_message',
  'session_message_chunk',
] as const;

/**
 * What this mapper can emit today.
 *
 * Maintained by hand ON PURPOSE. Deriving it from the source would make the
 * test agree with whatever the code does, which is the one thing a coverage
 * guard must not do -- it would have nothing to say when a kind silently
 * stopped being emitted.
 */
const IMPLEMENTED = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'available_commands_update',
  'notice',
  'tool_call',
  'tool_call_update',
  'usage_update',
] as const;

/**
 * Kinds this mapper does not emit, and why.
 *
 * Each reason was measured, not assumed. The plan group is the interesting one:
 * the CLI emits **no plan frame at all**. A captured turn that built a
 * three-item plan produced it entirely as ordinary `TaskCreate` / `TaskUpdate`
 * TOOL CALLS, with no new frame type anywhere in 139 frames. So ACP's three
 * plan kinds can only ever be SYNTHESISED here, by recognising those tool names
 * -- which is inference, and inference that silently stops working if the tool
 * names change. That is a decision to take deliberately, not a mapping to add
 * casually.
 */
const UNIMPLEMENTED: Readonly<Record<string, string>> = {
  user_message_chunk: 'needed for session/load history replay, which the CLI does not replay',
  plan: 'the CLI emits no plan frame; a plan arrives as TaskCreate/TaskUpdate tool calls',
  plan_update: 'would have to be synthesised from a TaskUpdate tool call, which is inference',
  plan_removed: 'the CLI never signals a plan being dropped, so there is nothing to map from',
  current_mode_update: 'permission mode changes are not announced on the stream',
  config_option_update: 'no CLI counterpart observed in any capture so far',
  session_info_update: 'no CLI counterpart observed in any capture so far',
  compaction_update: 'the CLI does compact context, but no frame for it has been captured yet',
  compaction_summary_chunk: 'same as compaction_update: the event has not been captured yet',
  subagent_update: 'subagent text arrives with parent_tool_use_id, not as its own kind',
  session_message: 'no CLI counterpart observed in any capture so far',
  session_message_chunk: 'no CLI counterpart observed in any capture so far',
};

const FIXTURES = ['claude-tool-turn.ndjson', 'claude-plan-turn.ndjson'];

function kindsProducedBy(fixture: string): Set<string> {
  const path = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
  const framer = new NdjsonFramer();
  const mapper = new ClaudeToAcp();
  const updates: AcpUpdate[] = [];
  for (const frame of [...framer.push(readFileSync(path)), ...framer.end()]) {
    if (frame.ok) updates.push(...mapper.frame(frame.value));
  }
  return new Set(updates.map((u) => u.sessionUpdate));
}

const producedAcrossAllCaptures = new Set(FIXTURES.flatMap((f) => [...kindsProducedBy(f)]));

describe('the two lists must stay consistent', () => {
  it('implements only kinds ACP defines', () => {
    // A typo in a discriminator would be invisible otherwise: a client ignores
    // what it does not recognise, so the update would simply never appear.
    for (const kind of IMPLEMENTED) {
      expect(ACP_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('accounts for all 19 kinds, with no kind in both lists and none missing', () => {
    // The conservation check: implemented + unimplemented must be exactly the
    // 19. Without it, a kind could quietly belong to neither list and this
    // whole file would stop covering it while still passing.
    const accounted = [...IMPLEMENTED, ...Object.keys(UNIMPLEMENTED)].sort();
    expect(accounted).toEqual([...ACP_KINDS].sort());
  });

  it('gives a REASON for every unimplemented kind', () => {
    // A list of names is a backlog; a list of names with reasons is a decision
    // record. Several of these reasons are "no CLI counterpart observed", which
    // is honest -- it says nobody has seen one, not that none exists.
    for (const [kind, reason] of Object.entries(UNIMPLEMENTED)) {
      expect(reason.length, kind).toBeGreaterThan(20);
    }
  });
});

describe('what the mapper claims versus what real traffic produced', () => {
  it('emits exactly the implemented list across every capture', () => {
    // Pinned both ways. If a kind stops being emitted this fails, rather than
    // the output merely getting shorter -- which is how a surface quietly stops
    // showing something nobody remembers it had.
    expect([...producedAcrossAllCaptures].sort()).toEqual([...IMPLEMENTED].sort());
  });

  it('has NO dead branch: every implemented kind appears in real traffic', () => {
    // tynn's question, answered from our own corpus. A kind handled but never
    // emitted by a real agent is code that looks like coverage and is not.
    for (const kind of IMPLEMENTED) {
      expect(producedAcrossAllCaptures.has(kind), `${kind} is handled but never emitted`).toBe(
        true,
      );
    }
  });

  it('covers 7 of 19, and says so out loud', () => {
    // Deliberately asserted as a NUMBER. "The mapper handles the kinds it has
    // seen" reads like completeness; 7 of 19 does not, and anyone raising the
    // first number has to come here and move the second.
    expect(IMPLEMENTED).toHaveLength(7);
    expect(ACP_KINDS).toHaveLength(19);
  });
});

describe('the plan finding, which is the reason three kinds are unimplemented', () => {
  it('confirms a real plan turn produced NO plan frame', () => {
    // 139 captured frames from a turn that built a three-item plan and moved
    // one to in_progress. If the CLI ever starts emitting a plan frame this
    // fails, and the synthesis decision gets revisited on evidence.
    const kinds = kindsProducedBy('claude-plan-turn.ndjson');
    expect(kinds.has('plan')).toBe(false);
    expect(kinds.has('plan_update')).toBe(false);
  });

  it('confirms the plan arrived as tool calls instead', () => {
    // Which is why synthesising ACP's plan kinds is possible at all -- and why
    // it is inference rather than translation.
    const path = fileURLToPath(new URL('./fixtures/claude-plan-turn.ndjson', import.meta.url));
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('TaskCreate');
    expect(raw).toContain('TaskUpdate');
  });

  it('maps those plan tool calls as ordinary tool calls, losing nothing', () => {
    // Until synthesis is decided, the plan is not dropped -- it is visible as
    // the tool calls that built it, with their arguments in rawInput. Worse
    // than a plan, better than silence.
    const path = fileURLToPath(new URL('./fixtures/claude-plan-turn.ndjson', import.meta.url));
    const framer = new NdjsonFramer();
    const mapper = new ClaudeToAcp();
    const updates: AcpUpdate[] = [];
    for (const frame of [...framer.push(readFileSync(path)), ...framer.end()]) {
      if (frame.ok) updates.push(...mapper.frame(frame.value));
    }

    const calls = updates.filter((u) => u.sessionUpdate === 'tool_call');
    expect(calls.some((c) => c.title === 'TaskCreate')).toBe(true);

    const withArgs = updates.find(
      (u) =>
        u.sessionUpdate === 'tool_call_update' &&
        JSON.stringify(u.rawInput ?? {}).includes('desk'),
    );
    expect(withArgs).toBeDefined();
  });
});
