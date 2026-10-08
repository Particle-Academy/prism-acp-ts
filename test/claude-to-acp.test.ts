import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { NdjsonFramer } from '../src/ndjson.js';
import {
  META_CLI_SESSION_ID,
  META_PERMISSION_DENIED,
  META_RATE_LIMIT,
  META_THINKING_SIGNATURE,
  META_THINKING_TOKENS_ESTIMATE,
} from '../src/meta.js';

/**
 * Real captured traffic, redacted for paths and identifiers only.
 *
 * It matters that this is a capture and not a hand-written fixture: a fixture
 * written from the same understanding as the mapper agrees with it by
 * construction, and proves only that the author was consistent.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/claude-tool-turn.ndjson', import.meta.url));

function mapFixture() {
  const framer = new NdjsonFramer();
  const mapper = new ClaudeToAcp();
  const updates: AcpUpdate[] = [];
  const bytes = readFileSync(FIXTURE);

  for (const frame of [...framer.push(bytes), ...framer.end()]) {
    expect(frame.ok).toBe(true);
    if (frame.ok) updates.push(...mapper.frame(frame.value));
  }
  return { updates, mapper };
}

function kindsOf(updates: AcpUpdate[]): Set<string> {
  return new Set(updates.map((u) => u.sessionUpdate));
}

describe('a real captured turn', () => {
  it('parses every line of the capture as NDJSON', () => {
    // Dogfoods the framer against real bytes rather than synthetic ones.
    const { updates } = mapFixture();
    expect(updates.length).toBeGreaterThan(0);
  });

  it('produces the kinds the turn actually contained', () => {
    const { updates } = mapFixture();
    expect(kindsOf(updates)).toEqual(
      new Set([
        'agent_message_chunk',
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
        'available_commands_update',
        'usage_update',
        'notice',
      ]),
    );
  });

  it('is not vacuous: a mapper returning nothing would fail this', () => {
    // The assertion that makes the rest mean something. Every "did it map X"
    // test below passes trivially for a mapper that emits [] for everything,
    // because an absent update cannot be wrong.
    const { updates } = mapFixture();
    expect(updates.length).toBeGreaterThan(40);
    expect(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').length).toBeGreaterThan(
      20,
    );
  });
});

describe('content mapping', () => {
  it('maps text deltas to agent_message_chunk and reassembles the reply', () => {
    const { updates } = mapFixture();
    const text = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.content as { text: string }).text)
      .join('');
    expect(text).toMatch(/line/i);
    expect(text.length).toBeGreaterThan(10);
  });

  it('maps thinking deltas to agent_thought_chunk, NOT to message chunks', () => {
    // The separation is the whole reason a structured transport beats scraping
    // a terminal: reasoning and reply are different things to a reader.
    const { updates } = mapFixture();
    const thoughts = updates.filter((u) => u.sessionUpdate === 'agent_thought_chunk');
    expect(thoughts.length).toBeGreaterThan(0);
  });

  it('carries the thinking-token ESTIMATE in _meta, never as usage', () => {
    const { updates } = mapFixture();
    const withEstimate = updates.filter(
      (u) => (u._meta as Record<string, unknown> | undefined)?.[META_THINKING_TOKENS_ESTIMATE] !==
        undefined,
    );
    expect(withEstimate.length).toBeGreaterThan(0);
    // And it must never have leaked into a usage_update, where a consumer would
    // sum an estimate alongside measurements.
    for (const usage of updates.filter((u) => u.sessionUpdate === 'usage_update')) {
      expect(JSON.stringify(usage)).not.toContain('estimate');
    }
  });

  it('PRESERVES the thinking-block signature', () => {
    // The easy default is to drop it: an exhaustive switch with no case for
    // signature_delta looks complete and quietly makes every thinking block
    // unverifiable. This asserts a real signature survived, not merely a key.
    const { updates } = mapFixture();
    const signatures = updates
      .map((u) => (u._meta as Record<string, unknown> | undefined)?.[META_THINKING_SIGNATURE])
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    expect(signatures.length).toBeGreaterThan(0);
    expect(signatures[0]!.length).toBeGreaterThan(20);
  });

  it('does not duplicate the reply from the complete assistant frames', () => {
    // With --include-partial-messages the full assistant message REPLAYS the
    // deltas. Mapping both would emit every word twice, and the bug would read
    // as a stutter rather than as a mapping error.
    //
    // Asserted EXACTLY rather than by a threshold. The first version of this
    // test counted occurrences of the word "line" and demanded fewer than six;
    // the real reply says it nine times, because it is a reply about the lines
    // in a file. The threshold was a guess, it failed on correct output, and a
    // guessed bound would have gone on being wrong in both directions.
    const { updates } = mapFixture();
    const mapped = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.content as { text: string }).text)
      .join('');

    // The deltas alone, straight from the fixture: the exact text a correct
    // mapper emits, no more and no less.
    const expected = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((f) => f.type === 'stream_event')
      .map((f) => (f.event as Record<string, unknown>) ?? {})
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => (e.delta as Record<string, unknown>) ?? {})
      .filter((d) => d.type === 'text_delta')
      .map((d) => d.text as string)
      .join('');

    expect(mapped).toBe(expected);
    expect(mapped.length).toBeGreaterThan(100);
  });
});

describe('permission denial mapping', () => {
  it('maps the captured denial to one failed tool update with sanitized detail', () => {
    const bytes = readFileSync(
      fileURLToPath(new URL('./fixtures/claude-permission-denied.jsonl', import.meta.url)),
    );
    const framer = new NdjsonFramer();
    const mapper = new ClaudeToAcp();
    const updates: AcpUpdate[] = [];
    for (const frame of [...framer.push(bytes), ...framer.end()]) {
      expect(frame.ok).toBe(true);
      if (frame.ok) updates.push(...mapper.frame(frame.value));
    }

    const denial = updates.filter((update) => update.sessionUpdate === 'tool_call_update');
    expect(denial).toHaveLength(1);
    expect(denial[0]).toMatchObject({
      toolCallId: 'REDACTED',
      status: 'failed',
      content: [{ content: { text: expect.stringContaining("don't ask mode") } }],
      _meta: {
        [META_PERMISSION_DENIED]: { tool_name: 'Write', decision_reason_type: 'mode' },
      },
    });
  });

  it('keeps an unmatched provider tool id visible instead of hiding its denial', () => {
    const updates = new ClaudeToAcp().frame({
      type: 'system', subtype: 'permission_denied', tool_use_id: 'unseen-call',
      message: 'denied', tool_name: 'Write',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'unseen-call',
      status: 'failed',
    });
  });

  it('sanitizes provider message and decision detail before the client sees them', () => {
    const [update] = new ClaudeToAcp().frame({
      type: 'system', subtype: 'permission_denied', tool_use_id: 'tool-1',
      message: '\u001b[31mdenied\u001b[0m', decision_reason: 'rule\u001b',
    });
    expect(update).toMatchObject({
      content: [{ content: { text: 'denied' } }],
      _meta: {
        [META_PERMISSION_DENIED]: { decision_reason: 'rule', providerTextSanitized: true },
      },
    });
  });

  it('omits content when the provider denial has no message', () => {
    const [update] = new ClaudeToAcp().frame({
      type: 'system', subtype: 'permission_denied', tool_use_id: 'tool-1', tool_name: 'Write',
    });
    expect(update).not.toHaveProperty('content');
  });

  it('records that provider text was sanitized without retaining the removed bytes', () => {
    const [update] = new ClaudeToAcp().frame({
      type: 'system', subtype: 'permission_denied', tool_use_id: 'tool-1',
      message: '\u001b[31mdenied\u001b[0m',
    });
    expect(update).toMatchObject({
      content: [{ content: { text: 'denied' } }],
      _meta: { [META_PERMISSION_DENIED]: { providerTextSanitized: true } },
    });
    expect(JSON.stringify(update)).not.toMatch(/[\u007f-\u009f]|\\u00(?:7f|8[0-9a-f]|9[0-9a-f])/i);
  });
});

describe('tool calls', () => {
  it('opens a tool_call with an id, a title and a recognised kind', () => {
    const { updates } = mapFixture();
    const call = updates.find((u) => u.sessionUpdate === 'tool_call');
    expect(call).toMatchObject({
      title: 'Read',
      name: 'Read',
      status: 'pending',
      kind: 'read', // `Read` is one of the ten; see TOOL_KINDS
    });
    expect(typeof call?.toolCallId).toBe('string');
  });

  it('closes it with a completed tool_call_update carrying the result', () => {
    const { updates } = mapFixture();
    const done = updates.filter(
      (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed',
    );
    expect(done.length).toBeGreaterThan(0);
    expect(JSON.stringify(done[0]?.content)).toMatch(/line one/);
  });

  it('attaches the accumulated arguments as rawInput, parsed', () => {
    // Fragments of a JSON string are not parseable, so they are accumulated and
    // only surfaced once whole -- a client shown half an argument list would
    // render something misleading about what is about to run.
    const { updates } = mapFixture();
    const withRaw = updates.find(
      (u) => u.sessionUpdate === 'tool_call_update' && u.rawInput !== undefined,
    );
    expect(withRaw?.rawInput).toBeTypeOf('object');
    expect(JSON.stringify(withRaw?.rawInput)).toMatch(/file_path/);
  });

  it('pairs every tool_call id with at least one update', () => {
    const { updates } = mapFixture();
    const opened = new Set(
      updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => u.toolCallId as string),
    );
    const updated = new Set(
      updates
        .filter((u) => u.sessionUpdate === 'tool_call_update')
        .map((u) => u.toolCallId as string),
    );
    expect(opened.size).toBeGreaterThan(0);
    for (const id of opened) expect(updated.has(id)).toBe(true);
  });
});

describe('usage', () => {
  it('reports used AND size, the two ACP requires', () => {
    const { updates } = mapFixture();
    const usage = updates.find((u) => u.sessionUpdate === 'usage_update');
    expect(typeof usage?.used).toBe('number');
    expect(typeof usage?.size).toBe('number');
    expect(usage?.used as number).toBeGreaterThan(0);
    // `size` comes from modelUsage.<model>.contextWindow, not from `usage` --
    // which is why a first reading of the capture concluded ACP's usage_update
    // could not be served at all.
    expect(usage?.size as number).toBeGreaterThan(1000);
  });

  it('reports cost with a currency', () => {
    const { updates } = mapFixture();
    const usage = updates.find((u) => u.sessionUpdate === 'usage_update');
    expect(usage?.cost).toMatchObject({ currency: 'USD' });
  });

  it('withholds usage_update entirely when no context size is known', () => {
    // ACP requires `size`. A required field is not somewhere to put a guess, so
    // a turn without a context window produces no usage_update at all.
    const mapper = new ClaudeToAcp();
    const updates = mapper.frame({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(updates.every((u) => u.sessionUpdate !== 'usage_update')).toBe(true);
  });
});

describe('frames with no ACP home are recorded, not dropped', () => {
  it('records the unmapped frames rather than counting them', () => {
    const { mapper } = mapFixture();
    expect(mapper.unmapped.length).toBeGreaterThan(0);
    // The frame itself is kept, so "what did we miss" has an answer.
    expect(mapper.unmapped.every((f) => typeof f === 'object' && f !== null)).toBe(true);
  });

  it('no longer records system/init, because it now carries the resume id', () => {
    // This test used to assert the opposite, and the opposite was a defect:
    // init carries the CLI's own session id, which is the ONLY string
    // `session/load` can resume with, and recording it as unmapped meant the
    // client was never sent the argument the resume method requires.
    const { mapper } = mapFixture();
    const subtypes = mapper.unmapped
      .map((f) => (f as { subtype?: string }).subtype)
      .filter(Boolean);
    expect(subtypes).not.toContain('init');

    // status and api_retry are still recorded -- api_retry especially, since it
    // is how an outranked credential announces itself.
    expect(subtypes).toContain('status');
  });

  it('maps system/init to a notice carrying the CLI session id', () => {
    const { updates } = mapFixture();
    const started = updates.find(
      (u) =>
        u.sessionUpdate === 'notice' &&
        (u._meta as Record<string, unknown> | undefined)?.[META_CLI_SESSION_ID] !== undefined,
    );

    expect(started).toBeDefined();
    const id = (started?._meta as Record<string, unknown>)[META_CLI_SESSION_ID];
    expect(typeof id).toBe('string');
    expect(id).not.toBe('');
  });

  it('emits it on the FIRST update, so a session that fails early is still resumable', () => {
    // A client cannot store what it was never sent, and a session can die
    // before its first turn completes.
    const { updates } = mapFixture();
    const index = updates.findIndex(
      (u) => (u._meta as Record<string, unknown> | undefined)?.[META_CLI_SESSION_ID] !== undefined,
    );
    expect(index).toBe(0);
  });

  it('records an init frame with no session_id rather than inventing one', () => {
    const mapper = new ClaudeToAcp();
    const updates = mapper.frame({ type: 'system', subtype: 'init', model: 'x' });

    expect(updates).toEqual([]);
    expect(mapper.unmapped.length).toBe(1);
  });

  it('does NOT record any content frame as unmapped', () => {
    // The guard against a mapper that quietly stops handling something: if a
    // content delta ever lands in `unmapped`, that is a regression and this
    // fails rather than the output merely getting shorter.
    //
    // `assistant` is in this list because of a mutation test. Disabling its
    // deliberate `return []` did not fail a single one of 93 tests: the frames
    // simply fell through to `unmapped`, nothing duplicated, nothing complained.
    // A deliberate ignore that can silently become an accidental drop is not
    // deliberate -- it is a comment. So it is asserted.
    const { mapper } = mapFixture();
    for (const frame of mapper.unmapped) {
      const f = frame as { type?: string };
      expect(f.type).not.toBe('stream_event');
      expect(f.type).not.toBe('user');
      expect(f.type).not.toBe('assistant');
    }
  });

  it('turns a rate_limit_event into a notice plus structured _meta', () => {
    const { updates } = mapFixture();
    const notice = updates.find(
      (u) =>
        u.sessionUpdate === 'notice' &&
        (u._meta as Record<string, unknown> | undefined)?.[META_RATE_LIMIT] !== undefined,
    );
    expect(notice).toBeDefined();
  });
});

describe('an unrecognised tool gets NO kind rather than "other"', () => {
  it('omits kind for a tool nobody here has seen', () => {
    // `other` asserts "this is none of the ten"; omitting says "we do not know
    // which". Only the second is true of a custom MCP tool. Same distinction as
    // `[]` versus `null`.
    const mapper = new ClaudeToAcp();
    const updates = mapper.frame({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'mcp__acme__do_thing', input: {} },
      },
    });
    expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call', title: 'mcp__acme__do_thing' });
    expect('kind' in updates[0]!).toBe(false);
  });

  it('still reports a kind for one it recognises', () => {
    const mapper = new ClaudeToAcp();
    const updates = mapper.frame({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} },
      },
    });
    expect(updates[0]).toMatchObject({ kind: 'execute' });
  });
});

describe('a failed tool result is reported as failed', () => {
  it('does not report a failure as completed', () => {
    const mapper = new ClaudeToAcp();
    const updates = mapper.frame({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'nope' }],
      },
    });
    expect(updates[0]).toMatchObject({ toolCallId: 't1', status: 'failed' });
  });
});
