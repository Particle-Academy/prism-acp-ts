import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { META_PARENT_TOOL_CALL } from '../src/meta.js';
import { NdjsonFramer } from '../src/ndjson.js';

/**
 * A SUBAGENT'S TOOL CALLS ARE ANNOUNCED, WITH THEIR PARENT. A subagent's calls arrive as whole `assistant` frames
 * carrying `parent_tool_use_id`, never as stream events, and the mapper ignored `assistant` content as a replay of
 * deltas. Their results still became tool_call_updates, so every inner call reached the client as an update for a call
 * it had never been told about: Genie rendered each as an empty "(tool call)" row (tynn, 2026-10-18).
 *
 * The fixture is a real capture (claude-code 2.1.301, --model haiku, 2026-10-18): one Agent call whose subagent Reads
 * three files. Measured on 0.16.0: three tool_call_updates with no tool_call before them.
 */
const PARENT = 'toolu_01BBn1FUVD111w39Hm3rZ4N6';

function mapCapture(): AcpUpdate[] {
  const framer = new NdjsonFramer();
  const mapper = new ClaudeToAcp();
  const bytes = readFileSync(fileURLToPath(new URL('./fixtures/claude-subagent-tools-turn.ndjson', import.meta.url)));
  return [...framer.push(bytes), ...framer.end()].flatMap((frame) => (frame.ok ? mapper.frame(frame.value) : []));
}

const parentOf = (u: AcpUpdate): unknown => (u._meta as Record<string, unknown> | undefined)?.[META_PARENT_TOOL_CALL];

describe('a subagent\'s tool calls', () => {
  it('leave no tool_call_update without a tool_call before it', () => {
    const announced = new Set<string>();
    const orphans: string[] = [];
    for (const update of mapCapture()) {
      if (update.sessionUpdate === 'tool_call') announced.add(update.toolCallId as string);
      if (update.sessionUpdate === 'tool_call_update' && !announced.has(update.toolCallId as string)) {
        orphans.push(update.toolCallId as string);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('are announced with their name, arguments and parent', () => {
    const inner = mapCapture().filter((u) => u.sessionUpdate === 'tool_call' && parentOf(u) === PARENT);
    expect(inner).toHaveLength(3);
    for (const call of inner) {
      expect(call.name).toBe('Read');
      expect(call.title).toBe('Read');
      expect(call.kind).toBe('read');
      expect(typeof (call.rawInput as Record<string, unknown>).file_path).toBe('string');
    }
  });

  it('carry the parent on their results too, so a client can nest or fold them', () => {
    const innerIds = new Set(mapCapture().filter((u) => u.sessionUpdate === 'tool_call' && parentOf(u) === PARENT)
      .map((u) => u.toolCallId));
    const results = mapCapture().filter((u) => u.sessionUpdate === 'tool_call_update' && innerIds.has(u.toolCallId as string));
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(parentOf(result)).toBe(PARENT);
      expect(result.status).toBe('completed');
    }
  });

  it('leave the main thread as it was: the Agent call once, no parent, no replay duplicated', () => {
    const main = mapCapture().filter((u) => u.sessionUpdate === 'tool_call' && parentOf(u) === undefined);
    expect(main.map((u) => u.name)).toEqual(['Agent']);
  });

  it('announce a subagent call once, even when its frame is repeated', () => {
    const mapper = new ClaudeToAcp();
    const frame = {
      type: 'assistant', parent_tool_use_id: 'toolu_parent',
      message: { id: 'msg_sub', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Read', input: { file_path: 'a.txt' } }] },
    };
    const updates = [...mapper.frame(frame), ...mapper.frame(frame)].filter((u) => u.sessionUpdate === 'tool_call');
    expect(updates).toHaveLength(1);
  });
});
