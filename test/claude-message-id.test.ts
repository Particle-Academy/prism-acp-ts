import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { NdjsonFramer } from '../src/ndjson.js';

/**
 * G-312: EVERY CLAUDE `agent_message_chunk` NAMES ITS ASSISTANT MESSAGE. Without an id, a reply interrupted by a tool call
 * or a subagent notice and then continued as a NEW assistant message was joined to the first in Genie ("...its gate.All
 * three..."). The id is the Anthropic message id from the stream's `message_start`; when the stream gives none, one is
 * generated at that boundary. Codex chunks already carried `messageId` at the update's root, and Claude's match it.
 */

const start = (id: unknown, parent: string | null = null) =>
  ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id, usage: { input_tokens: 1, output_tokens: 1 } } } });
const stop = (parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_stop' } });
const block = (index: number, type: 'text' | 'tool_use', parent: string | null = null) => ({
  type: 'stream_event', parent_tool_use_id: parent,
  event: { type: 'content_block_start', index, content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: 'toolu_1', name: 'Bash' } },
});
const text = (index: number, said: string, parent: string | null = null) =>
  ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: said } } });
const blockStop = (index: number) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index } });
const toolResult = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } };
const taskStarted = { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1', description: 'a subagent', task_type: 'local_agent' };
const taskEnded = { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'completed', summary: 'done' };

function chunks(frames: unknown[]): AcpUpdate[] {
  const mapper = new ClaudeToAcp();
  return frames.flatMap((frame) => mapper.frame(frame)).filter((u) => u.sessionUpdate === 'agent_message_chunk');
}

const textOf = (u: AcpUpdate) => (u.content as { text: string }).text;

describe('Claude agent_message_chunk carries its assistant message id', () => {
  it('text, then a tool call, then more text in a NEW assistant message: two distinct ids', () => {
    const updates = chunks([
      start('msg_A'), block(0, 'text'), text(0, 'Checking its gate.'), blockStop(0),
      block(1, 'tool_use'), blockStop(1), stop(),
      toolResult,
      start('msg_B'), block(0, 'text'), text(0, 'All three'), text(0, ' pass.'), blockStop(0), stop(),
    ]);
    expect(updates.map((u) => [u.messageId, textOf(u)])).toEqual([
      ['msg_A', 'Checking its gate.'], ['msg_B', 'All three'], ['msg_B', ' pass.'],
    ]);
  });

  it('many chunks of one message share one id (the real captured turn)', () => {
    const framer = new NdjsonFramer();
    const mapper = new ClaudeToAcp();
    const updates: AcpUpdate[] = [];
    const bytes = readFileSync(fileURLToPath(new URL('./fixtures/claude-tool-turn.ndjson', import.meta.url)));
    for (const frame of [...framer.push(bytes), ...framer.end()]) if (frame.ok) updates.push(...mapper.frame(frame.value));
    const said = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
    expect(said.length).toBeGreaterThan(10);
    expect(new Set(said.map((u) => u.messageId))).toEqual(new Set(['msg_011CfjqUwstY4gKBZkv2k63t']));
  });

  it('a subagent or task notice between two messages does not merge them', () => {
    const updates = chunks([
      start('msg_A'), block(0, 'text'), text(0, 'Delegating.'), blockStop(0), stop(),
      taskStarted,
      // A subagent's own message, mid-way: it must neither take nor lend an id.
      start('msg_SUB', 'toolu_1'), block(0, 'text', 'toolu_1'), text(0, 'sub says', 'toolu_1'), stop('toolu_1'),
      taskEnded,
      start('msg_B'), block(0, 'text'), text(0, 'Back.'), stop(),
    ]);
    expect(updates.map((u) => [u.messageId, textOf(u)])).toEqual([
      ['msg_A', 'Delegating.'], ['msg_SUB', 'sub says'], ['msg_B', 'Back.'],
    ]);
  });

  it('a subagent message_start in the MIDDLE of a main-thread message does not re-label its text', () => {
    const updates = chunks([
      start('msg_A'), block(0, 'text'), text(0, 'one'),
      start('msg_SUB', 'toolu_1'),
      text(0, 'two'), stop(),
    ]);
    expect(updates.map((u) => u.messageId)).toEqual(['msg_A', 'msg_A']);
  });

  it.each([
    ['missing', undefined], ['empty', ''], ['not a string', 42], ['too long', `msg_${'x'.repeat(300)}`],
    ['carrying a control character', 'msg_\u001b[2J'], ['carrying a space', 'msg_A msg_B'],
  ])('an upstream id that is %s is not used: one is GENERATED at the message start, stable for that message', (_label, id) => {
    const updates = chunks([
      start(id), block(0, 'text'), text(0, 'a'), text(0, 'b'), stop(),
      start(id), block(0, 'text'), text(0, 'c'), stop(),
    ]);
    const [first, second, third] = updates.map((u) => u.messageId as string);
    expect(first).toMatch(/^prism_msg_[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(third).toMatch(/^prism_msg_/);
    expect(third).not.toBe(first);
  });

  it('text with no message_start at all still gets one id, kept until the stop, and a new one after', () => {
    const updates = chunks([text(0, 'a'), text(0, 'b'), stop(), text(0, 'c')]);
    const ids = updates.map((u) => u.messageId as string);
    expect(ids[0]).toMatch(/^prism_msg_/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('a synthetic message and a local command\'s output each get their own id', () => {
    const mapper = new ClaudeToAcp();
    const synthetic = mapper.frame({ type: 'assistant', message: { id: 'msg_syn', model: '<synthetic>', content: [{ type: 'text', text: 'No messages to compact' }] } });
    expect(synthetic).toEqual([{ sessionUpdate: 'agent_message_chunk', messageId: 'msg_syn', content: { type: 'text', text: 'No messages to compact' } }]);
    const [first] = mapper.frame({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } });
    const [second] = mapper.frame({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } });
    expect(first!.messageId).toMatch(/^prism_msg_/);
    expect(second!.messageId).not.toBe(first!.messageId);
  });
});

class Transport implements CodexTransport {
  readonly #handlers: CodexTransportHandlers;
  constructor(handlers: CodexTransportHandlers) { this.#handlers = handlers; }
  async start(): Promise<void> {}
  send(raw: unknown): void {
    const frame = raw as Record<string, unknown>;
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    let result: unknown = {};
    if (frame.method === 'thread/start') result = { thread: { id: 'thread-1' } };
    if (frame.method === 'account/rateLimits/read') result = { rateLimits: { primary: null, secondary: null } };
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }
  close(): void {}
  frame(value: unknown): void { this.#handlers.onFrame(value); }
}

describe('the field name and placement match the Codex driver exactly', () => {
  it('both drivers put `messageId` at the update root, beside `content`, and nowhere else', async () => {
    let transport!: Transport;
    const updates: Record<string, unknown>[] = [];
    const factory: CodexTransportFactory = (_o, handlers) => (transport = new Transport(handlers));
    const driver = new CodexDriver({ cwd: '/w', parentEnv: {} }, { onUpdate: (u) => updates.push(u) }, factory);
    driver.start();
    await driver.ready;
    transport.frame({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'item-1', delta: 'hi' } });
    const codex = updates.find((u) => u.sessionUpdate === 'agent_message_chunk')!;
    const [claude] = chunks([start('msg_A'), block(0, 'text'), text(0, 'hi')]);

    expect(Object.keys(claude!).sort()).toEqual(Object.keys(codex).sort());
    expect(Object.keys(claude!).sort()).toEqual(['content', 'messageId', 'sessionUpdate']);
    expect(typeof codex.messageId).toBe('string');
    expect(typeof claude!.messageId).toBe('string');
    expect(Object.keys(claude!.content as object)).toEqual(Object.keys(codex.content as object));
  });
});
