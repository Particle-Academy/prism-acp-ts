import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { turnOutcomeOf } from '../src/claude/driver.js';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { META_COMPACTION, META_LOCAL_COMMAND } from '../src/meta.js';

/**
 * A BUILT-IN COMMAND IS A TURN THAT FINISHED (tynn, from the owner's /compact, 2026-10-19). A local command such as
 * /compact runs no model turn, so the CLI's result carries `stop_reason: null` -- with `subtype: 'success'`,
 * `is_error: false`, `num_turns: 0`. TurnOutcome reads a null stop reason as "did not finish cleanly", so Genie showed a
 * working compaction as a failure. And the compaction itself reached the client as nothing at all.
 *
 * Both fixtures are real captures (claude-code 2.1.301, haiku, 2026-10-19), with the machine's command list, plugin
 * list and the compaction summary (which quoted its instructions) removed:
 *   claude-compact-turn.json   /compact on a session with history: compact_boundary, the summary, the stdout, result
 *   claude-compact-empty.json  /compact on an empty session: a SYNTHETIC assistant message, never streamed, then result
 */
const frames = (name: string): unknown[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')) as unknown[];
const resultOf = (name: string) => frames(name).find((f) => (f as { type?: string }).type === 'result');
const mapped = (name: string): AcpUpdate[] => {
  const mapper = new ClaudeToAcp();
  return frames(name).flatMap((frame) => mapper.frame(frame));
};
const text = (updates: AcpUpdate[]) => updates.filter((u) => u.sessionUpdate === 'agent_message_chunk')
  .map((u) => (u.content as { text: string }).text);

describe('a local command\'s outcome', () => {
  it('a /compact that worked is a turn that FINISHED: end_turn, not an error', () => {
    expect(turnOutcomeOf(resultOf('claude-compact-turn.json'))).toMatchObject({ stopReason: 'end_turn', isError: false });
    expect(turnOutcomeOf(resultOf('claude-compact-empty.json'))).toMatchObject({ stopReason: 'end_turn', isError: false });
  });

  it('a result that IS an error keeps a null stop reason (the control)', () => {
    expect(turnOutcomeOf({ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null }))
      .toMatchObject({ stopReason: null, isError: true });
    expect(turnOutcomeOf({ type: 'result', subtype: 'success', is_error: true, stop_reason: null }))
      .toMatchObject({ stopReason: null, isError: true });
  });

  it('an ordinary model turn is untouched (the control)', () => {
    expect(turnOutcomeOf({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'max_tokens' }))
      .toMatchObject({ stopReason: 'max_tokens', isError: false });
  });
});

describe('a compaction reaches the client', () => {
  it('as a notice carrying the trigger and both token counts', () => {
    const notice = mapped('claude-compact-turn.json')
      .find((u) => (u._meta as Record<string, unknown> | undefined)?.[META_COMPACTION] !== undefined);
    expect(notice?.sessionUpdate).toBe('notice');
    expect((notice?._meta as Record<string, unknown>)[META_COMPACTION]).toMatchObject({
      trigger: 'manual', preTokens: 40_341, postTokens: 3_942,
    });
  });

  it('with the command\'s own output as agent text, marked as a local command, and NOT the summary', () => {
    const updates = mapped('claude-compact-turn.json');
    const chunks = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
    expect(chunks.map((u) => (u.content as { text: string }).text)).toEqual(['Compacted']);
    expect((chunks[0]?._meta as Record<string, unknown>)[META_LOCAL_COMMAND]).toBe(true);
    expect(JSON.stringify(updates)).not.toContain('being continued');
  });

  it('and moves the context meter to what is left after it', () => {
    const usage = mapped('claude-compact-turn.json').find((u) => u.sessionUpdate === 'usage_update');
    expect(usage?.used).toBe(3_942);
  });
});

describe('a synthetic assistant message', () => {
  it('reaches the client as text: it never streams, so it would otherwise be lost', () => {
    expect(text(mapped('claude-compact-empty.json'))).toEqual(['Error: No messages to compact']);
  });

  it('is not an API call: its zero usage never becomes the context meter', () => {
    expect(mapped('claude-compact-empty.json').filter((u) => u.sessionUpdate === 'usage_update')).toEqual([]);
    // The capture's result has no context window, which alone withholds the update. With one, a synthetic message
    // counted as a call would report used: 0 and empty the meter.
    const mapper = new ClaudeToAcp();
    const [synthetic] = frames('claude-compact-empty.json');
    const updates = [
      ...mapper.frame(synthetic),
      ...mapper.frame({ type: 'result', subtype: 'success', is_error: false, stop_reason: null, usage: {},
        modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000 } } }),
    ];
    expect(updates.filter((u) => u.sessionUpdate === 'usage_update')).toEqual([]);
  });
});
