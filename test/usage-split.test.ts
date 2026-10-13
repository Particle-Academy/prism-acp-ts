import { describe, expect, it } from 'vitest';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { META_USAGE } from '../src/meta.js';

/**
 * USAGE: THE SPLIT, AND A `used` THAT COUNTS THE CONTEXT (issue #3). Claude's result frame carries the input/output
 * split and the cached input; `ClaudeToAcp` folded `input_tokens + output_tokens` into `used` and dropped the rest.
 * Measured 2026-10-13 on claude-code with `--model haiku`, one one-word turn:
 *   usage = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 18999, cache_creation_input_tokens: 16522 }
 * so `used` said 6 while the context held ~35.5k — a client's context bar read nearly empty (Genie showed
 * "context 675 / 1000k"). `used` now counts ALL input (fresh, cache read, cache written) plus output, and the split rides
 * as `_meta[particle.academy/usage]` with its scope: Claude's figures cover the TURN, Codex's are the THREAD's running
 * totals. Codex keeps its bare `_meta` keys too, so nothing that reads them breaks.
 */
const MEASURED = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 18999, cache_creation_input_tokens: 16522 };
const result = (usage: Record<string, unknown>) => ({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', total_cost_usd: 0.01, usage,
    modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000 } },
});

describe('Claude', () => {
    it('used counts every input token the context holds, plus output; the split rides in _meta with scope turn', () => {
        const usage = new ClaudeToAcp().frame(result(MEASURED)).find((u) => u.sessionUpdate === 'usage_update')!;
        expect(usage.used).toBe(2 + 18999 + 16522 + 4);
        expect(usage.size).toBe(1_000_000);
        expect((usage._meta as Record<string, unknown>)[META_USAGE]).toEqual({
            scope: 'turn', inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 18999, cacheCreationInputTokens: 16522,
        });
    });

    it('cache figures the CLI did not send count as nothing in used and are null in the split — never a guess', () => {
        const usage = new ClaudeToAcp().frame(result({ input_tokens: 10, output_tokens: 5 })).find((u) => u.sessionUpdate === 'usage_update')!;
        expect(usage.used).toBe(15);
        expect((usage._meta as Record<string, unknown>)[META_USAGE]).toEqual({
            scope: 'turn', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: null, cacheCreationInputTokens: null,
        });
    });
});

class UsageTransport implements CodexTransport {
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

describe('Codex', () => {
    it('the thread totals ride in the namespaced split with scope thread, and the bare keys stay', async () => {
        let transport!: UsageTransport;
        const factory: CodexTransportFactory = (_o, handlers) => (transport = new UsageTransport(handlers));
        const updates: Record<string, unknown>[] = [];
        const driver = new CodexDriver({ cwd: '/w', parentEnv: {} }, { onUpdate: (u) => updates.push(u as Record<string, unknown>) }, factory);
        driver.start();
        await new Promise<void>((r) => setImmediate(r));
        transport.frame({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 't1', tokenUsage: {
            total: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800, reasoningOutputTokens: 40, totalTokens: 1500 },
            last: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800, reasoningOutputTokens: 40, totalTokens: 1500 },
            modelContextWindow: 272_000,
        } } });
        const usage = updates.find((u) => u.sessionUpdate === 'usage_update')!;
        const meta = usage._meta as Record<string, unknown>;
        expect(meta[META_USAGE]).toEqual({ scope: 'thread', inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800, reasoningOutputTokens: 40 });
        expect(meta.inputTokens).toBe(1200);
        expect(meta.outputTokens).toBe(300);
    });
});
