import { describe, expect, it } from 'vitest';
import { claudeArgs } from '../src/claude/driver.js';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { META_CLI_SESSION_ID, META_MODEL } from '../src/meta.js';

/**
 * THE MODEL: CHOSEN BY THE CLIENT, REPORTED BY THE PROVIDER (issue #5). A client could neither choose the model a
 * session runs on nor learn which one it got. Both providers already offer both halves:
 *
 *  - Claude Code takes `--model <alias|id>`; its first `system`/`init` frame carries `model` — measured 2026-10-13 on
 *    claude-code with `--model haiku`: `init.model = 'claude-haiku-5-5'`;
 *  - Codex's app-server takes `model` on `thread/start` and `thread/resume` and RETURNS the `model` in use (its own
 *    generated protocol types, codex-cli 0.156.1: `ThreadStartResponse.model: string`), and announces a switch with
 *    `model/rerouted` (`fromModel`, `toModel`).
 *
 * The model reaches the client as `_meta[particle.academy/model]` on a notice, only when the provider said it: no model
 * reported is no key — never a guessed default.
 */
describe('Claude', () => {
    it('--model carries the option; no option, no flag', () => {
        const args = claudeArgs({ cwd: '/w', model: 'haiku' });
        expect(args[args.indexOf('--model') + 1]).toBe('haiku');
        expect(claudeArgs({ cwd: '/w' })).not.toContain('--model');
    });

    it('an empty model, or one that reads as a flag, is refused rather than passed to the CLI', () => {
        expect(() => claudeArgs({ cwd: '/w', model: '' })).toThrow(/model/);
        expect(() => claudeArgs({ cwd: '/w', model: '--dangerously-skip-permissions' })).toThrow(/model/);
    });

    it('the init frame reports the model beside the CLI session id; an init with no model reports none', () => {
        const withModel = new ClaudeToAcp().frame({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-haiku-5-5' });
        expect(withModel).toHaveLength(1);
        const meta = withModel[0]!._meta as Record<string, unknown>;
        expect(meta[META_CLI_SESSION_ID]).toBe('sess-1');
        expect(meta[META_MODEL]).toBe('claude-haiku-5-5');

        const without = new ClaudeToAcp().frame({ type: 'system', subtype: 'init', session_id: 'sess-2' });
        expect(Object.hasOwn(without[0]!._meta as object, META_MODEL)).toBe(false);
    });
});

class ModelTransport implements CodexTransport {
    readonly sent: Record<string, unknown>[] = [];
    readonly #handlers: CodexTransportHandlers;
    readonly #model: string | undefined;
    constructor(handlers: CodexTransportHandlers, model: string | undefined) { this.#handlers = handlers; this.#model = model; }
    async start(): Promise<void> {}
    send(raw: unknown): void {
        const frame = raw as Record<string, unknown>;
        this.sent.push(frame);
        if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
        const params = frame.params as Record<string, unknown> | undefined;
        const model = this.#model === undefined ? {} : { model: this.#model };
        let result: unknown = {};
        if (frame.method === 'thread/start') result = { thread: { id: 'thread-1' }, ...model };
        if (frame.method === 'thread/resume') result = { thread: { id: params?.threadId }, ...model };
        if (frame.method === 'thread/turns/list') result = { data: [], nextCursor: null };
        if (frame.method === 'account/rateLimits/read') result = { rateLimits: { primary: null, secondary: null } };
        queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
    }
    close(): void {}
    frame(value: unknown): void { this.#handlers.onFrame(value); }
}

function codex(options: { model?: string; resumeSessionId?: string }, reported: string | undefined) {
    let transport!: ModelTransport;
    const factory: CodexTransportFactory = (_o, handlers) => (transport = new ModelTransport(handlers, reported));
    const updates: Record<string, unknown>[] = [];
    const driver = new CodexDriver({ cwd: '/w', parentEnv: {}, ...options }, { onUpdate: (u) => updates.push(u as Record<string, unknown>) }, factory);
    return { driver, updates, get transport() { return transport; } };
}
const settle = () => new Promise<void>((r) => setImmediate(r));
const models = (updates: readonly Record<string, unknown>[]) => updates.flatMap((u) => { const m = u._meta as Record<string, unknown> | undefined; return m && Object.hasOwn(m, META_MODEL) ? [m[META_MODEL]] : []; });

describe('Codex', () => {
    it('thread/start carries the option and the model in use is reported; no option, no param', async () => {
        const c = codex({ model: 'gpt-5.5-codex' }, 'gpt-5.5-codex');
        c.driver.start();
        await settle();
        const start = c.transport.sent.find((f) => f.method === 'thread/start')!;
        expect((start.params as Record<string, unknown>).model).toBe('gpt-5.5-codex');
        expect(models(c.updates)).toEqual(['gpt-5.5-codex']);

        const plain = codex({}, 'gpt-5.5');
        plain.driver.start();
        await settle();
        expect(Object.hasOwn(plain.transport.sent.find((f) => f.method === 'thread/start')!.params as object, 'model')).toBe(false);
        // The provider's default, as the provider names it.
        expect(models(plain.updates)).toEqual(['gpt-5.5']);
    });

    it('thread/resume carries the option too', async () => {
        const c = codex({ model: 'gpt-5.5', resumeSessionId: 'thread-9' }, 'gpt-5.5');
        c.driver.start();
        await settle();
        expect((c.transport.sent.find((f) => f.method === 'thread/resume')!.params as Record<string, unknown>).model).toBe('gpt-5.5');
    });

    it('a response with no model reports none (positive control: the same driver reports one when it is there)', async () => {
        const c = codex({}, undefined);
        c.driver.start();
        await settle();
        expect(models(c.updates)).toEqual([]);
    });

    it('model/rerouted reports the model it switched to', async () => {
        const c = codex({}, 'gpt-5.5');
        c.driver.start();
        await settle();
        c.transport.frame({ jsonrpc: '2.0', method: 'model/rerouted', params: { threadId: 'thread-1', turnId: 't1', fromModel: 'gpt-5.5', toModel: 'gpt-5.5-mini', reason: 'overloaded' } });
        expect(models(c.updates)).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    });

    it('an empty model, or one that reads as a flag, is refused', () => {
        expect(() => codex({ model: '' }, undefined).driver.start()).toThrow(/model/);
    });
});
