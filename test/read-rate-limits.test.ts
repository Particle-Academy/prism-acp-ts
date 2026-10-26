import { describe, expect, it } from 'vitest';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { META_RATE_LIMIT, META_UNMAPPED_FRAME } from '../src/meta.js';

/**
 * genie#1195: a Codex login held on a spent window stayed paused until the
 * window's STATED reset, days after the limit really cleared. The driver only
 * read limits at start and during a turn, and a held agent runs no turns, so the
 * host needed a way to ask again without starting one.
 */
class RateLimitTransport implements CodexTransport {
  readonly sent: Record<string, unknown>[] = [];
  /** Answers for successive account/rateLimits/read requests; an Error answers with a JSON-RPC error. */
  readonly answers: (Record<string, unknown> | Error)[];
  readonly #handlers: CodexTransportHandlers;

  constructor(handlers: CodexTransportHandlers, answers: (Record<string, unknown> | Error)[]) {
    this.#handlers = handlers;
    this.answers = answers;
  }

  async start(): Promise<void> {}

  send(raw: unknown): void {
    const frame = raw as Record<string, unknown>;
    this.sent.push(frame);
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    let result: unknown = {};
    if (frame.method === 'thread/start') result = { thread: { id: 'thread-1' } };
    if (frame.method === 'account/rateLimits/read') {
      const answer = this.answers.shift() ?? new Error('no answer queued');
      if (answer instanceof Error) {
        queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: answer.message } }));
        return;
      }
      result = answer;
    }
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }

  close(): void {}
}

const spent = {
  ordinaryUsageAllowed: false,
  rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_861_000_000 }, secondary: null },
};
const cleared = {
  ordinaryUsageAllowed: true,
  rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1_861_600_000 }, secondary: null },
};

async function started(answers: (Record<string, unknown> | Error)[]) {
  let transport!: RateLimitTransport;
  const factory: CodexTransportFactory = (_o, handlers) => (transport = new RateLimitTransport(handlers, answers));
  const updates: Record<string, unknown>[] = [];
  const driver = new CodexDriver({ cwd: '/w', parentEnv: {} }, { onUpdate: (u) => updates.push(u as Record<string, unknown>) }, factory);
  driver.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { driver, transport, updates };
}

const readings = (updates: Record<string, unknown>[]) =>
  updates
    .map((update) => (update._meta as Record<string, unknown> | undefined)?.[META_RATE_LIMIT] as Record<string, unknown> | undefined)
    .filter((reading) => reading !== undefined);

describe('CodexDriver.readRateLimits', () => {
  it('re-reads the account limits on demand and emits the reading, without starting a turn', async () => {
    const { driver, transport, updates } = await started([spent, cleared]);

    expect(readings(updates).map((reading) => reading.ordinaryUsageAllowed)).toEqual([false]);

    await driver.readRateLimits();

    expect(readings(updates).map((reading) => reading.ordinaryUsageAllowed)).toEqual([false, true]);
    expect(transport.sent.filter((frame) => frame.method === 'account/rateLimits/read')).toHaveLength(2);
    expect(transport.sent.some((frame) => frame.method === 'turn/start')).toBe(false);
  });

  it('reports a failed read on the session instead of rejecting, as the start-up read does', async () => {
    const { driver, updates } = await started([spent, new Error('account service unavailable')]);

    await expect(driver.readRateLimits()).resolves.toBeUndefined();

    expect(readings(updates)).toHaveLength(1);
    expect(updates.some((update) => {
      const unmapped = (update._meta as Record<string, unknown> | undefined)?.[META_UNMAPPED_FRAME] as Record<string, unknown> | undefined;
      return String(unmapped?.reason ?? '').includes('account/rateLimits/read failed');
    })).toBe(true);
  });
});
