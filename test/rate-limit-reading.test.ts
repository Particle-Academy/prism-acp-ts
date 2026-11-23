/**
 * G-328: one provider-neutral reading of usage windows. Every case asks what a consumer would conclude, because the
 * failure this type exists to stop is an empty or partial result being read as plenty of headroom.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import { readRateLimit, rateLimitNotice } from '../src/claude/rate-limit.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { META_RATE_LIMIT, META_RATE_LIMIT_READING, META_UNMAPPED_FRAME } from '../src/meta.js';
import {
  claudeRateLimitReading,
  codexRateLimitReading,
  notYetReportedRateLimitReading,
  unsupportedRateLimitReading,
  type RateLimitReading,
} from '../src/index.js';

const NOW = 1_850_000_000_000;
const RESET = 1_861_000_000;
const derived = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/claude-rate-limit-derived.json', import.meta.url)), 'utf8')) as {
  weeklyOnlyAllowed: Record<string, unknown>;
  rejectedWithoutWindows: Record<string, unknown>;
};

const claudeWindow = (utilization: number, extra: Record<string, unknown> = {}) => ({ utilization, resetsAt: RESET, ...extra });
const claude = (windows: Record<string, unknown>, rateLimitType = 'five_hour', status = 'allowed') => ({
  status,
  resetsAt: RESET,
  rateLimitType,
  unifiedWindows: windows,
});
const weekly = { usedPercent: 40, windowDurationMins: 10080, resetsAt: RESET };
const fiveHour = { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET };

const readingOf = (update: { _meta?: unknown } | undefined) =>
  (update?._meta as Record<string, unknown> | undefined)?.[META_RATE_LIMIT_READING] as RateLimitReading | undefined;

describe('Claude mapping', () => {
  it('reads a weekly-only frame without inventing a five-hour window', () => {
    const reading = claudeRateLimitReading(derived.weeklyOnlyAllowed, NOW);
    expect(reading).toEqual({
      state: 'reported',
      asOfMs: NOW,
      limited: false,
      absent: 'not_stated',
      windows: [{ id: 'claude:seven_day', label: 'seven day', lengthSeconds: null, usedPercent: 15, resetsAtMs: RESET * 1000, binding: true }],
    });
  });

  it('marks only the provider-named window as binding when both are present', () => {
    const reading = claudeRateLimitReading(claude({ five_hour: claudeWindow(0.25), seven_day: claudeWindow(0.5) }, 'seven_day'), NOW);
    expect(reading.windows.map((window) => [window.id, window.usedPercent])).toEqual([['claude:five_hour', 25], ['claude:seven_day', 50]]);
    expect(reading.windows[1]!.binding).toBe(true);
    expect('binding' in reading.windows[0]!).toBe(false);
    expect(reading.windows.every((window) => window.lengthSeconds === null)).toBe(true);
  });

  it('does not cap utilization above 1', () => {
    expect(claudeRateLimitReading(claude({ five_hour: claudeWindow(1.4) }), NOW).windows[0]!.usedPercent).toBe(140);
  });

  it('refuses a utilization whose percentage is not a finite number, because JSON would turn it into null', () => {
    const reading = claudeRateLimitReading(claude({ five_hour: claudeWindow(Number.MAX_VALUE) }), NOW);
    expect(reading).toMatchObject({ state: 'unreadable', windows: [] });
  });

  it('refuses a malformed window whole, with the reason and no partial reading', () => {
    const reading = claudeRateLimitReading(claude({ five_hour: claudeWindow(0.5), seven_day: { utilization: 'high', resetsAt: RESET } }), NOW);
    expect(reading).toEqual({
      state: 'unreadable',
      reason: 'rate_limit: unifiedWindows.seven_day.utilization expected finite number >= 0, got string(4)',
      asOfMs: NOW,
      limited: false,
      windows: [],
      absent: 'not_stated',
    });
  });

  it('keeps hostile keys as data and never binds through the prototype', () => {
    const windows = JSON.parse(`{"__proto__":{"utilization":0.5,"resetsAt":${RESET}},"toString":{"utilization":0.25,"resetsAt":${RESET}}}`) as Record<string, unknown>;
    const reading = claudeRateLimitReading(claude(windows, 'constructor'), NOW);
    expect(reading.windows.map((window) => window.id)).toEqual(['claude:__proto__', 'claude:toString']);
    expect(reading.windows.some((window) => 'binding' in window)).toBe(false);
    expect(({} as Record<string, unknown>).utilization).toBeUndefined();
  });

  it('refuses an oversized or control-character window name without quoting it', () => {
    for (const name of ['x'.repeat(65), 'secret\u001b[2Jvalue', 'has space']) {
      const reading = claudeRateLimitReading(claude({ [name]: claudeWindow(0.5) }, name), NOW);
      expect(reading).toMatchObject({ state: 'unreadable', windows: [] });
      expect(reading.reason).not.toContain(name);
    }
  });

  it('refuses more windows than it will carry rather than dropping some', () => {
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`w${index}`, claudeWindow(0.1)]));
    expect(claudeRateLimitReading(claude(many), NOW)).toMatchObject({ state: 'unreadable', windows: [] });
  });

  it('sets window-level limited only from a present status that is not allowed', () => {
    const reading = claudeRateLimitReading(claude({
      five_hour: claudeWindow(1, { status: 'rejected' }),
      seven_day: claudeWindow(0.5, { status: 'allowed' }),
      other: claudeWindow(0.1),
      odd: claudeWindow(0.1, { status: 7 }),
    }), NOW);
    expect(reading.windows[0]!.limited).toBe(true);
    for (const window of reading.windows.slice(1)) expect('limited' in window).toBe(false);
  });

  it('does not carry the per-window status string or overage detail into the reading', () => {
    const text = JSON.stringify(claudeRateLimitReading(derived.weeklyOnlyAllowed, NOW));
    for (const leaked of ['overage', 'org_level_disabled', '"status"', 'raw']) expect(text).not.toContain(leaked);
  });
});

describe('a Claude rejection with no unifiedWindows (shape from a transcript rejection record)', () => {
  it('parses with no windows and a notice that names the window and reset, with no percentage', () => {
    const read = readRateLimit(derived.rejectedWithoutWindows);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.limit.windows).toEqual({});
    const notice = rateLimitNotice(read.limit);
    expect(notice).toContain('five_hour');
    expect(notice).toContain(new Date(RESET * 1000).toISOString());
    expect(notice).not.toContain('%');
  });

  it('stays refused when status is allowed, or when the map is present but malformed', () => {
    const { unifiedWindows: _omitted, ...allowed } = derived.weeklyOnlyAllowed;
    expect(readRateLimit(allowed).ok).toBe(false);
    expect(readRateLimit({ ...derived.rejectedWithoutWindows, unifiedWindows: null }).ok).toBe(false);
    expect(readRateLimit({ ...derived.rejectedWithoutWindows, unifiedWindows: [] }).ok).toBe(false);
  });

  it('maps to a limited reading whose percentage is null, never a guessed 100', () => {
    expect(claudeRateLimitReading(derived.rejectedWithoutWindows, NOW)).toEqual({
      state: 'reported',
      asOfMs: NOW,
      limited: true,
      absent: 'not_stated',
      windows: [{ id: 'claude:five_hour', label: 'five hour', lengthSeconds: null, usedPercent: null, resetsAtMs: RESET * 1000, binding: true }],
    });
  });

  it('refuses a rejection whose window name cannot be carried safely', () => {
    const reading = claudeRateLimitReading({ ...derived.rejectedWithoutWindows, rateLimitType: 'bad name\u001b' }, NOW);
    expect(reading).toMatchObject({ state: 'unreadable', windows: [] });
    expect(reading.reason).not.toContain('bad name');
  });

  it('reaches _meta through the real mapper instead of unmapped_frame', () => {
    const [update] = new ClaudeToAcp().frame({ type: 'rate_limit_event', rate_limit_info: derived.rejectedWithoutWindows });
    const meta = update!._meta as Record<string, unknown>;
    expect(meta[META_UNMAPPED_FRAME]).toBeUndefined();
    expect(meta[META_RATE_LIMIT]).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour', windows: {} });
    expect(readingOf(update)).toMatchObject({ state: 'reported', limited: true, windows: [{ id: 'claude:five_hour', usedPercent: null }] });
  });
});

describe('Claude frames through ClaudeToAcp', () => {
  it('emits the reading beside an unchanged rate_limit value', () => {
    const [update] = new ClaudeToAcp().frame({ type: 'rate_limit_event', rate_limit_info: derived.weeklyOnlyAllowed });
    const read = readRateLimit(derived.weeklyOnlyAllowed);
    expect((update!._meta as Record<string, unknown>)[META_RATE_LIMIT]).toEqual(read.ok ? read.limit : undefined);
    expect(readingOf(update)).toMatchObject({ state: 'reported', windows: [{ id: 'claude:seven_day', usedPercent: 15 }] });
  });

  it('emits an unreadable reading beside the unmapped frame on a refusal', () => {
    const [update] = new ClaudeToAcp().frame({ type: 'rate_limit_event', rate_limit_info: claude({ five_hour: { utilization: null, resetsAt: RESET } }) });
    expect((update!._meta as Record<string, unknown>)[META_UNMAPPED_FRAME]).toBeDefined();
    expect(readingOf(update)).toMatchObject({ state: 'unreadable', windows: [] });
  });

  it('says unsupported for an API-key session', () => {
    const [update] = new ClaudeToAcp(undefined, { rateLimitsSupported: false }).frame({ type: 'rate_limit_event', rate_limit_info: derived.weeklyOnlyAllowed });
    expect(readingOf(update)).toMatchObject({ state: 'unsupported', windows: [] });
  });
});

describe('Codex mapping', () => {
  it('names a weekly window in primary by its length, not its slot', () => {
    const reading = codexRateLimitReading({ rateLimits: { primary: weekly, secondary: null } }, NOW);
    expect(reading).toEqual({
      state: 'reported',
      asOfMs: NOW,
      limited: false,
      absent: 'provider_says_none',
      windows: [{ id: 'codex:10080m', label: '7 days', lengthSeconds: 604800, usedPercent: 40, resetsAtMs: RESET * 1000 }],
    });
  });

  it('reads secondary when primary is null', () => {
    const reading = codexRateLimitReading({ rateLimits: { primary: null, secondary: weekly } }, NOW);
    expect(reading.windows.map((window) => window.id)).toEqual(['codex:10080m']);
    expect(reading.absent).toBe('provider_says_none');
  });

  it('tells an explicit null from an omitted key', () => {
    expect(codexRateLimitReading({ rateLimits: { primary: weekly, secondary: null } }, NOW).absent).toBe('provider_says_none');
    const omitted = codexRateLimitReading({ rateLimits: { primary: weekly } }, NOW);
    expect(omitted).toMatchObject({ state: 'reported', absent: 'not_stated' });
    expect(omitted.windows).toHaveLength(1);
  });

  it('does not claim the provider said none when both slots hold windows', () => {
    expect(codexRateLimitReading({ rateLimits: { primary: fiveHour, secondary: weekly } }, NOW).absent).toBe('not_stated');
  });

  it('treats a payload with neither slot as unreadable, because a renamed field must not read as no windows', () => {
    expect(codexRateLimitReading({ rateLimits: { credits: null } }, NOW)).toMatchObject({ state: 'unreadable', windows: [] });
  });

  it('never reads a null slot in a sparse update as the provider saying none', () => {
    const reading = codexRateLimitReading({ primary: weekly, secondary: null }, NOW, { sparse: true });
    expect(reading).toMatchObject({ state: 'reported', absent: 'not_stated' });
  });

  it('keeps ids unique and stable when both slots have the same length', () => {
    const reading = codexRateLimitReading({ rateLimits: { primary: weekly, secondary: { ...weekly, usedPercent: 3 } } }, NOW);
    expect(reading.windows.map((window) => window.id)).toEqual(['codex:10080m', 'codex:10080m:2']);
  });

  it('refuses a malformed window whole', () => {
    const reading = codexRateLimitReading({ rateLimits: { primary: weekly, secondary: { usedPercent: 'x', windowDurationMins: 300, resetsAt: RESET } } }, NOW);
    expect(reading).toMatchObject({ state: 'unreadable', windows: [] });
    expect(reading.reason).toContain('rateLimits.secondary.usedPercent');
  });

  it('refuses a rateLimits container that is present but not an object', () => {
    expect(codexRateLimitReading({ rateLimits: 'nope', primary: weekly, secondary: null }, NOW)).toMatchObject({ state: 'unreadable', windows: [] });
  });

  it('refuses a window length too large to state in seconds', () => {
    const huge = { ...weekly, windowDurationMins: Number.MAX_SAFE_INTEGER };
    expect(codexRateLimitReading({ rateLimits: { primary: huge, secondary: null } }, NOW)).toMatchObject({ state: 'unreadable', windows: [] });
  });

  it('sets limited only from fields that say so, and never marks a window binding from a reached type', () => {
    expect(codexRateLimitReading({ ordinaryUsageAllowed: false, rateLimits: { primary: weekly, secondary: null } }, NOW).limited).toBe(true);
    expect(codexRateLimitReading({ ordinaryUsageAllowed: null, rateLimits: { primary: { ...weekly, usedPercent: 100 }, secondary: null } }, NOW).limited).toBe(false);
    const reached = codexRateLimitReading({ rateLimits: { primary: weekly, secondary: null, rateLimitReachedType: 'rate_limit_reached' } }, NOW);
    expect(reached.limited).toBe(true);
    expect('binding' in reached.windows[0]!).toBe(false);
  });

  it('leaks no plan, account or limit identifiers', () => {
    const text = JSON.stringify(codexRateLimitReading({
      accountId: 'acct-private',
      rateLimits: { limitId: 'limit-private', limitName: 'name-private', planType: 'plan-private', primary: weekly, secondary: null },
    }, NOW));
    for (const leaked of ['private', 'planType', 'accountId', 'limitId']) expect(text).not.toContain(leaked);
  });
});

describe('readings with nothing to report', () => {
  it('are distinct states with no windows, and never claim the provider said none', () => {
    for (const [reading, state] of [[notYetReportedRateLimitReading(NOW), 'not_yet_reported'], [unsupportedRateLimitReading(NOW), 'unsupported']] as const) {
      expect(reading).toEqual({ state, asOfMs: NOW, limited: false, windows: [], absent: 'not_stated' });
    }
  });
});

class FakeCodex implements CodexTransport {
  readonly #handlers: CodexTransportHandlers;
  readonly #answers: (Record<string, unknown> | Error)[];

  constructor(handlers: CodexTransportHandlers, answers: (Record<string, unknown> | Error)[]) {
    this.#handlers = handlers;
    this.#answers = answers;
  }

  async start(): Promise<void> {}
  close(): void {}

  notify(method: string, params: unknown): void {
    this.#handlers.onFrame({ jsonrpc: '2.0', method, params });
  }

  send(raw: unknown): void {
    const frame = raw as Record<string, unknown>;
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    let result: unknown = {};
    if (frame.method === 'thread/start') result = { thread: { id: 'thread-1' } };
    if (frame.method === 'account/login/start') result = { type: 'apiKey' };
    if (frame.method === 'account/rateLimits/read') {
      const answer = this.#answers.shift() ?? new Error('no answer queued');
      if (answer instanceof Error) {
        queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: answer.message } }));
        return;
      }
      result = answer;
    }
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function codexSession(answers: (Record<string, unknown> | Error)[], apiKey = false) {
  let transport!: FakeCodex;
  const factory: CodexTransportFactory = (_options, handlers) => (transport = new FakeCodex(handlers, answers));
  const updates: { _meta?: unknown }[] = [];
  const credentials = apiKey ? { credentials: { mode: 'apiKey' as const, apiKey: 'sk-fixture-only', home: mkdtempSync(join(tmpdir(), 'g328-')) } } : {};
  if ('credentials' in credentials) homes.push(credentials.credentials.home);
  const driver = new CodexDriver({ cwd: '/w', parentEnv: {}, ...credentials }, { onUpdate: (update) => updates.push(update as { _meta?: unknown }) }, factory);
  driver.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  return { driver, transport, updates, readings: () => updates.map(readingOf).filter((reading) => reading !== undefined) };
}

describe('Codex frames through the driver', () => {
  const read = { ordinaryUsageAllowed: true, rateLimits: { primary: weekly, secondary: null } };

  it('emits the reading beside an unchanged rate_limit value, at start and on readRateLimits', async () => {
    const { driver, updates, readings } = await codexSession([read, read]);
    await driver.readRateLimits();
    expect(readings()).toHaveLength(2);
    expect(readings()[1]).toMatchObject({ state: 'reported', absent: 'provider_says_none', windows: [{ id: 'codex:10080m' }] });
    const carrying = updates.find((update) => readingOf(update) !== undefined)!;
    expect((carrying._meta as Record<string, unknown>)[META_RATE_LIMIT]).toMatchObject({ primary: { usedPercent: 40 }, secondary: null });
  });

  it('a sparse update with a null slot never says the provider has no such window', async () => {
    const { transport, readings } = await codexSession([read]);
    transport.notify('account/rateLimits/updated', { rateLimits: { primary: fiveHour, secondary: null } });
    expect(readings().at(-1)).toMatchObject({ state: 'reported', absent: 'not_stated', windows: [{ id: 'codex:300m' }] });
  });

  it('a sparse update carrying no window and no limit emits no reading to overwrite the last one', async () => {
    const { transport, readings } = await codexSession([read]);
    const before = readings().length;
    transport.notify('account/rateLimits/updated', { rateLimits: { primary: null, secondary: null } });
    expect(readings()).toHaveLength(before);
  });

  it('a refused payload emits unreadable beside the unmapped frame', async () => {
    const { readings } = await codexSession([{ rateLimits: { primary: { usedPercent: 'x' }, secondary: null } }]);
    expect(readings().at(-1)).toMatchObject({ state: 'unreadable', windows: [] });
  });

  it('a failed read emits unreadable without the error text', async () => {
    const { readings } = await codexSession([new Error('private service detail')]);
    expect(readings().at(-1)).toMatchObject({ state: 'unreadable', reason: 'account/rateLimits/read failed', windows: [] });
    expect(JSON.stringify(readings())).not.toContain('private service detail');
  });

  it('says unsupported for an API-key session', async () => {
    const { readings } = await codexSession([read], true);
    expect(readings().at(-1)).toMatchObject({ state: 'unsupported', windows: [] });
  });
});
