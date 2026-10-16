import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { META_USAGE } from '../src/meta.js';
import { NdjsonFramer } from '../src/ndjson.js';

/**
 * `used` IS HOW FULL THE CONTEXT IS, NOT HOW MUCH THE TURN SPENT. ACP's usage_update `used` means tokens currently in
 * the context window. Claude's `result` frame totals EVERY API call in the turn, so a turn with many tool calls summed
 * the same context once per call: Genie showed "6364.9k / 1000.0k" (reported by tynn, 2026-10-16). The context is the
 * LAST main-thread call's input (fresh + cache read + cache written) plus its output.
 */

const SIZE = 1_000_000;
const call = (id: string, usage: Record<string, number>, parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { id, role: 'assistant', content: [], usage },
});
const result = (usage: Record<string, number>) => ({
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5, usage,
  modelUsage: { 'claude-opus-5-5': { contextWindow: SIZE } },
});
const usageOf = (updates: AcpUpdate[]) => updates.find((u) => u.sessionUpdate === 'usage_update');

function run(frames: unknown[]): AcpUpdate[] {
  const mapper = new ClaudeToAcp();
  return frames.flatMap((frame) => mapper.frame(frame));
}

function fixture(name: string): AcpUpdate[] {
  const framer = new NdjsonFramer();
  const mapper = new ClaudeToAcp();
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return [...framer.push(bytes), ...framer.end()].flatMap((frame) => (frame.ok ? mapper.frame(frame.value) : []));
}

describe('Claude: used is the last call, not the turn', () => {
  it('a 3-call turn whose last call reads a large cache reports that call, not the sum', () => {
    const calls = [
      { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200, output_tokens: 50 },
      { input_tokens: 8, cache_read_input_tokens: 1_200, cache_creation_input_tokens: 90, output_tokens: 40 },
      { input_tokens: 5, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 300, output_tokens: 80 },
    ];
    const total = calls.reduce((sum, c) => ({
      input_tokens: sum.input_tokens + c.input_tokens,
      cache_read_input_tokens: sum.cache_read_input_tokens + c.cache_read_input_tokens,
      cache_creation_input_tokens: sum.cache_creation_input_tokens + c.cache_creation_input_tokens,
      output_tokens: sum.output_tokens + c.output_tokens,
    }));
    const usage = usageOf(run([...calls.map((c, i) => call(`msg_${i}`, c)), result(total)]))!;

    expect(usage.used).toBe(5 + 600_000 + 300 + 80);
    // The turn total stays in _meta, where it is right for cost.
    expect((usage._meta as Record<string, unknown>)[META_USAGE]).toMatchObject({
      scope: 'turn', cacheReadInputTokens: 602_200,
    });
  });

  it('a single-call turn gives the same value either way (the control)', () => {
    const only = { input_tokens: 2, cache_read_input_tokens: 18_999, cache_creation_input_tokens: 16_522, output_tokens: 4 };
    expect(usageOf(run([call('msg_1', only), result(only)]))!.used).toBe(2 + 18_999 + 16_522 + 4);
  });

  it('never exceeds size for a well-formed turn, however many calls it made', () => {
    // Twelve calls each re-reading a 400k context: the turn total is 4.8M, five times the window.
    const each = { input_tokens: 3, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 500, output_tokens: 60 };
    const frames = Array.from({ length: 12 }, (_, i) => call(`msg_${i}`, each));
    const usage = usageOf(run([...frames, result({
      input_tokens: 36, cache_read_input_tokens: 4_800_000, cache_creation_input_tokens: 6_000, output_tokens: 720,
    })]))!;
    expect(usage.used).toBeLessThanOrEqual(usage.size as number);
    expect(usage.used).toBe(3 + 400_000 + 500 + 60);
  });

  it('ignores a SUBAGENT call: its context is not the conversation the meter shows', () => {
    const main = { input_tokens: 2, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 100, output_tokens: 20 };
    const sub = { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 25_000, output_tokens: 4 };
    const usage = usageOf(run([call('msg_main', main), call('msg_sub', sub, 'toolu_task'), result(main)]))!;
    expect(usage.used).toBe(2 + 30_000 + 100 + 20);
  });

  it('takes the final output from the call\'s message_delta, not the snapshot on its assistant frame', () => {
    const snapshot = { input_tokens: 2, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 100, output_tokens: 3 };
    const usage = usageOf(run([
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1', usage: snapshot } } },
      call('msg_1', snapshot),
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: {}, usage: { ...snapshot, output_tokens: 391 } } },
      result({ ...snapshot, output_tokens: 391 }),
    ]))!;
    expect(usage.used).toBe(2 + 9_000 + 100 + 391);
  });

  it('sends no usage_update when the turn reported no per-call usage, rather than a guess', () => {
    const updates = run([result({ input_tokens: 10, output_tokens: 5 })]);
    expect(usageOf(updates)).toBeUndefined();
  });

  it('does not carry one turn\'s last call into the next turn', () => {
    const one = { input_tokens: 1, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0, output_tokens: 1 };
    const updates = run([call('msg_1', one), result(one), result({ input_tokens: 4, output_tokens: 4 })]);
    expect(updates.filter((u) => u.sessionUpdate === 'usage_update')).toHaveLength(1);
  });

  it('on a captured subagent turn, reports the last MAIN call: 36,312, not the turn total of 70,143', () => {
    expect(usageOf(fixture('claude-subagent-turn.ndjson'))!.used).toBe(2 + 2_472 + 33_663 + 175);
  });
});

class UsageTransport implements CodexTransport {
  readonly #handlers: CodexTransportHandlers;
  constructor(handlers: CodexTransportHandlers) { this.#handlers = handlers; }
  async start(): Promise<void> {}
  send(raw: unknown): void {
    const frame = raw as Record<string, unknown>;
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    let reply: unknown = {};
    if (frame.method === 'thread/start') reply = { thread: { id: 'thread-1' } };
    if (frame.method === 'account/rateLimits/read') reply = { rateLimits: { primary: null, secondary: null } };
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result: reply }));
  }
  close(): void {}
  frame(value: unknown): void { this.#handlers.onFrame(value); }
}

async function codexUsage(tokenUsage: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  let transport!: UsageTransport;
  const factory: CodexTransportFactory = (_o, handlers) => (transport = new UsageTransport(handlers));
  const updates: Record<string, unknown>[] = [];
  const driver = new CodexDriver({ cwd: '/w', parentEnv: {} }, { onUpdate: (u) => updates.push(u as Record<string, unknown>) }, factory);
  driver.start();
  await new Promise<void>((r) => setImmediate(r));
  transport.frame({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 't9', tokenUsage } });
  return updates.find((u) => u.sessionUpdate === 'usage_update');
}

describe('Codex: used is the last request, not the thread total', () => {
  // Codex's own source (codex-rs/tui/src/token_usage.rs): for `last_token_usage`, total_tokens "is the latest active
  // context size; for `total_token_usage`, this is the accumulated session total".
  const breakdown = (input: number, output: number) =>
    ({ inputTokens: input, outputTokens: output, cachedInputTokens: Math.floor(input * 0.9), reasoningOutputTokens: 10, totalTokens: input + output });

  it('reports last.totalTokens, while the thread totals stay in _meta', async () => {
    const usage = (await codexUsage({ total: breakdown(2_400_000, 30_000), last: breakdown(150_000, 2_000), modelContextWindow: 272_000 }))!;
    expect(usage.used).toBe(152_000);
    expect(usage.size).toBe(272_000);
    expect((usage._meta as Record<string, unknown>)[META_USAGE]).toMatchObject({ scope: 'thread', inputTokens: 2_400_000 });
  });

  it('sends no usage_update without a last breakdown, rather than the thread total', async () => {
    expect(await codexUsage({ total: breakdown(2_400_000, 30_000), modelContextWindow: 272_000 })).toBeUndefined();
  });
});
