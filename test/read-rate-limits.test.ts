import { describe, expect, it } from 'vitest';
import { codexRateLimitNotice, readCodexRateLimit } from '../src/index.js';
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

  /** Deliver a frame as Codex would, for the notification path. */
  frame(raw: unknown): void {
    this.#handlers.onFrame(raw);
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

/**
 * Tynn #1050: a payload that omitted one window lost the whole Codex reading, and a reading held only in `secondary`
 * was announced as unavailable. Nothing here assumes which window is the 5-hour one: Codex reports the duration.
 */
describe('Codex rate-limit windows that are absent', () => {
  const weekly = { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1_861_000_000 };
  const short = { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_860_000_000 };
  const weeklyRead = { usedPercent: 37, windowDurationMins: 10080, resetsAtMs: 1_861_000_000_000 };
  const shortRead = { usedPercent: 12, windowDurationMins: 300, resetsAtMs: 1_860_000_000_000 };
  const unavailable = 'Codex rate limit usage is unavailable.';

  const notices = (updates: Record<string, unknown>[]) =>
    updates
      .filter((update) => META_RATE_LIMIT in ((update._meta as Record<string, unknown> | undefined) ?? {}))
      .map((update) => (update.notice as { message: string }).message);
  const unmappedReasons = (updates: Record<string, unknown>[]) =>
    updates
      .map((update) => (update._meta as Record<string, unknown> | undefined)?.[META_UNMAPPED_FRAME] as Record<string, unknown> | undefined)
      .filter((unmapped) => unmapped !== undefined)
      .map((unmapped) => String(unmapped.reason));

  it('reads an omitted secondary as no window and keeps the primary reading', () => {
    expect(readCodexRateLimit({ rateLimits: { primary: short } })).toMatchObject({
      ok: true, limit: { primary: shortRead, secondary: null },
    });
  });

  it('reads an omitted primary as no window and keeps the secondary reading', () => {
    expect(readCodexRateLimit({ rateLimits: { secondary: weekly } })).toMatchObject({
      ok: true, limit: { primary: null, secondary: weeklyRead },
    });
  });

  it.each([
    ['explicit nulls', { rateLimits: { primary: null, secondary: null } }],
    ['an explicit null primary alone', { rateLimits: { primary: null } }],
    ['an explicit null secondary alone', { rateLimits: { secondary: null } }],
  ])('reports %s as unavailable, never as a usage figure', (_name, payload) => {
    const read = readCodexRateLimit(payload);
    expect(read).toMatchObject({ ok: true, limit: { primary: null, secondary: null } });
    if (read.ok) expect(codexRateLimitNotice(read.limit)).toBe(unavailable);
  });

  it.each([
    ['an empty snapshot', { rateLimits: {} }],
    ['an empty payload', {}],
    ['a snapshot with only credits', { rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '1' } } }],
    ['a payload with only the usage flag', { ordinaryUsageAllowed: true }],
  ])('refuses %s, which carries no window information', (_name, payload) => {
    expect(readCodexRateLimit(payload)).toEqual({
      ok: false, reason: 'codex_rate_limit: rateLimits.primary expected an object or null, got undefined',
    });
  });

  it.each(['primary', 'secondary'])('still refuses the whole payload when a present %s is malformed', (key) => {
    for (const bad of [0, 'x', true, [], {}, { ...short, usedPercent: -1 }, { ...short, resetsAt: 0 }]) {
      const read = readCodexRateLimit({ rateLimits: { [key]: bad } });
      expect(read).toMatchObject({ ok: false, reason: expect.stringContaining(`rateLimits.${key}`) });
    }
  });

  it.each([['garbage'], [7], [true], [[]], [null]])('refuses a present rateLimits that is not an object: %j', (rateLimits) => {
    // Tolerating absent windows must not turn a malformed container into an "unavailable" success.
    expect(readCodexRateLimit({ rateLimits })).toMatchObject({
      ok: false, reason: expect.stringContaining('rateLimits expected an object'),
    });
  });

  it('reports the secondary window, with its own duration, when primary has no reading', () => {
    const read = readCodexRateLimit({ rateLimits: { primary: null, secondary: weekly } });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(codexRateLimitNotice(read.limit)).toBe(
        `Codex rate limit: 37% used in 10080 minutes, resets ${new Date(1_861_000_000_000).toISOString()}.`,
      );
    }
  });

  it.each([
    ['secondary when it is the more spent', short, weekly, '37% used in 10080 minutes'],
    ['primary when it is the more spent', weekly, short, '37% used in 10080 minutes'],
    ['primary on a tie', { ...short, usedPercent: 37 }, weekly, '37% used in 300 minutes'],
  ])('reports %s', (_name, primary, secondary, expected) => {
    const read = readCodexRateLimit({ rateLimits: { primary, secondary } });
    expect(read.ok).toBe(true);
    if (read.ok) expect(codexRateLimitNotice(read.limit)).toContain(expected);
  });

  it('carries the more spent window into the driver notice', async () => {
    const { updates } = await started([{ rateLimits: { primary: short, secondary: weekly } }]);

    expect(readings(updates)).toMatchObject([{ primary: shortRead, secondary: weeklyRead }]);
    expect(notices(updates)).toEqual([expect.stringContaining('37% used in 10080 minutes')]);
  });

  it('carries a reading with an omitted primary through the driver read', async () => {
    const { updates } = await started([{ ordinaryUsageAllowed: true, rateLimits: { secondary: weekly } }]);

    expect(readings(updates)).toMatchObject([{ primary: null, secondary: weeklyRead }]);
    expect(notices(updates)).toEqual([expect.stringContaining('37% used in 10080 minutes')]);
    expect(unmappedReasons(updates).filter((reason) => reason.startsWith('codex_rate_limit'))).toEqual([]);
  });

  it('carries a frame with an omitted secondary through the driver notification', async () => {
    const { transport, updates } = await started([spent]);
    transport.frame({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: { primary: short } } });

    expect(readings(updates).at(-1)).toMatchObject({ primary: shortRead, secondary: null });
    expect(notices(updates).at(-1)).toContain('12% used in 300 minutes');
  });

  it('does not replace a good reading when a frame carries no window information', async () => {
    const { transport, updates } = await started([spent]);
    const before = notices(updates);
    transport.frame({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: {} } });

    expect(readings(updates)).toHaveLength(1);
    expect(notices(updates)).toEqual(before);
    expect(unmappedReasons(updates)).toContainEqual(expect.stringContaining('rateLimits.primary expected an object or null, got undefined'));
  });

  it('emits no reading when the driver read carries no window information', async () => {
    const { updates } = await started([{ ordinaryUsageAllowed: true }]);

    expect(readings(updates)).toEqual([]);
    expect(unmappedReasons(updates)).toContainEqual(expect.stringContaining('rateLimits.primary expected an object or null, got undefined'));
  });

  it('still announces explicit nulls as unavailable through the driver', async () => {
    const { transport, updates } = await started([spent]);
    transport.frame({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: { primary: null, secondary: null } } });

    expect(readings(updates).at(-1)).toMatchObject({ primary: null, secondary: null });
    expect(notices(updates).at(-1)).toBe(unavailable);
  });

  it('emits no reading for a malformed window through the driver', async () => {
    const { transport, updates } = await started([spent]);
    const before = readings(updates).length;
    transport.frame({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: { secondary: 'must-not-echo' } } });

    expect(readings(updates)).toHaveLength(before);
    expect(unmappedReasons(updates)).toContainEqual(expect.stringContaining('rateLimits.secondary'));
    expect(JSON.stringify(updates)).not.toContain('must-not-echo');
  });
});
