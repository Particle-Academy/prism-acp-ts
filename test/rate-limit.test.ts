/**
 * The rate-limit payload: what the parse accepts, and what it must refuse.
 *
 * The cases that matter here are the refusals. A parse that accepts a payload
 * and returns a partial value is worse than no parse at all, because a gauge
 * built from half a payload still looks like a reading -- so most of this file
 * asserts that something does NOT come back.
 *
 * The accepting cases are driven by READING THE FIXTURES rather than by a copy
 * of the JSON pasted in here. A test written against a copy agrees with the
 * parse by construction and would keep passing after the capture was replaced.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { META_RATE_LIMIT, META_UNMAPPED_FRAME } from '../src/meta.js';
import { parseRateLimit, rateLimitNotice } from '../src/claude/rate-limit.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Every `rate_limit_info` in every capture on disk, with the file it came from. */
function capturedPayloads(): { file: string; payload: Record<string, unknown> }[] {
  const found: { file: string; payload: Record<string, unknown> }[] = [];

  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.ndjson'))) {
    const text = readFileSync(`${FIXTURES}/${file}`, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame.type === 'rate_limit_event') {
        found.push({ file, payload: frame.rate_limit_info as Record<string, unknown> });
      }
    }
  }
  return found;
}

/** One captured payload, as a mutable copy to damage in the refusal cases. */
function onePayload(): Record<string, unknown> {
  const [first] = capturedPayloads();
  expect(first).toBeDefined();
  return structuredClone(first.payload);
}

describe('the captured payloads', () => {
  it('finds a rate_limit_event in every capture -- otherwise this file tests nothing', () => {
    const payloads = capturedPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    expect(new Set(payloads.map((p) => p.file)).size).toBe(
      readdirSync(FIXTURES).filter((f) => f.endsWith('.ndjson')).length,
    );
  });

  it('parses every one of them', () => {
    for (const { file, payload } of capturedPayloads()) {
      const parsed = parseRateLimit(payload);
      expect(parsed, `${file} should parse`).toBeDefined();
      expect(parsed?.status).toBe('allowed');
      expect(Object.keys(parsed?.windows ?? {})).toContain('five_hour');
    }
  });

  it('PINS THE UNIT: epoch seconds in, epoch milliseconds out', () => {
    // The provider's field is `resetsAt` with no unit in the name, and it is in
    // SECONDS. Read as milliseconds, every reset time lands in January 1970.
    // This asserts the real dates so a switch to milliseconds by the provider
    // fails HERE rather than in a consumer's clock -- which is also why no
    // seconds-vs-ms heuristic is applied in the parse.
    const byWindow = new Map<number, string>([
      [Date.parse('2026-10-06T04:20:00Z'), 'five_hour'],
      [Date.parse('2026-10-05T23:20:00Z'), 'five_hour'],
      [Date.parse('2026-10-11T11:00:00Z'), 'seven_day'],
    ]);

    for (const { file, payload } of capturedPayloads()) {
      const parsed = parseRateLimit(payload);
      expect(parsed, file).toBeDefined();

      for (const [name, window] of Object.entries(parsed?.windows ?? {})) {
        expect(byWindow.get(window.resetsAtMs), `${file}/${name} resets at a known date`).toBe(
          name,
        );
      }
    }
  });

  it('keeps the provider object verbatim, including a key the type does not declare', () => {
    const payload = { ...onePayload(), somethingNewTheProviderAdded: 42 };
    const parsed = parseRateLimit(payload);

    // A field the provider ADDS still parses -- only a rename refuses -- and
    // `raw` is what stops the new field being dropped by a type that does not
    // know about it yet.
    expect(parsed?.raw.somethingNewTheProviderAdded).toBe(42);
    expect(parsed?.raw).toEqual(payload);
  });
});

describe('what the parse refuses', () => {
  it('refuses a renamed field rather than returning a partial', () => {
    const payload = onePayload();
    payload.resets_at = payload.resetsAt;
    delete payload.resetsAt;

    // The whole point: a rename must not yield a value with a missing number in
    // it, because that is what a gauge renders as empty.
    expect(parseRateLimit(payload)).toBeUndefined();
  });

  it('refuses the WHOLE payload when one window is malformed', () => {
    const payload = onePayload();
    const windows = payload.unifiedWindows as Record<string, Record<string, unknown>>;
    windows.five_hour.utilization = '0.12';

    // Not "drop five_hour and keep seven_day". A consumer whose binding window
    // went bad would then be shown the other window's healthy figure with
    // nothing marking the substitution.
    expect(parseRateLimit(payload)).toBeUndefined();
    expect(Object.keys(windows)).toContain('seven_day');
  });

  it('refuses an absent unifiedWindows', () => {
    const payload = onePayload();
    delete payload.unifiedWindows;

    // It is the only part that answers "how much is left", so a typed value
    // without it would be a reset time masquerading as a gauge.
    expect(parseRateLimit(payload)).toBeUndefined();
  });

  it('refuses a non-object, and a null, and an array', () => {
    expect(parseRateLimit(undefined)).toBeUndefined();
    expect(parseRateLimit(null)).toBeUndefined();
    expect(parseRateLimit('allowed')).toBeUndefined();
    expect(parseRateLimit([onePayload()])).toBeUndefined();
  });

  it('refuses a non-finite or non-positive reset time', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, '1791260400']) {
      const payload = onePayload();
      payload.resetsAt = bad;
      expect(parseRateLimit(payload), String(bad)).toBeUndefined();
    }
  });
});

describe('what the parse must NOT refuse', () => {
  it('accepts a status nobody here has ever captured', () => {
    const payload = onePayload();
    payload.status = 'something_we_have_never_seen';

    // No breached frame has ever been captured, so the breached spelling is
    // unknown. A closed union would turn the first real breach into a
    // consumer's build error -- the guarded-against failure, inverted.
    expect(parseRateLimit(payload)?.status).toBe('something_we_have_never_seen');
  });

  it('accepts utilization above 1, because overage is a real state', () => {
    const payload = onePayload();
    (payload.unifiedWindows as Record<string, Record<string, unknown>>).five_hour.utilization = 1.4;
    payload.isUsingOverage = true;

    // Capping at 1 would be a figure this package invented. Clamping belongs at
    // the point of display, where `isUsingOverage` is visible alongside it.
    expect(parseRateLimit(payload)?.windows.five_hour?.utilization).toBe(1.4);
    expect(parseRateLimit(payload)?.isUsingOverage).toBe(true);
  });

  it('accepts an empty unifiedWindows map, and omits optional fields that are absent', () => {
    const payload = onePayload();
    payload.unifiedWindows = {};
    delete payload.overageStatus;
    delete payload.isUsingOverage;

    const parsed = parseRateLimit(payload);
    expect(parsed?.windows).toEqual({});
    expect('overageStatus' in (parsed ?? {})).toBe(false);
    expect('isUsingOverage' in (parsed ?? {})).toBe(false);
  });
});

describe('the human-readable half', () => {
  it('carries the figures, not a sentence with no content in it', () => {
    const parsed = parseRateLimit(onePayload());
    expect(parsed).toBeDefined();
    if (parsed === undefined) return;

    const message = rateLimitNotice(parsed);
    expect(message).toContain('five_hour');
    expect(message).toMatch(/\d+% used/);
    expect(message).toContain('2026-10-0');
  });

  it('falls back to the top-level reset when the binding window is absent', () => {
    const payload = onePayload();
    payload.unifiedWindows = {};

    const parsed = parseRateLimit(payload);
    expect(parsed).toBeDefined();
    if (parsed === undefined) return;

    const message = rateLimitNotice(parsed);
    expect(message).not.toContain('% used');
    expect(message).toContain(new Date(parsed.resetsAtMs).toISOString());
  });
});

describe('through the mapper', () => {
  function mapFrame(rateLimitInfo: unknown): AcpUpdate[] {
    return new ClaudeToAcp().frame({
      type: 'rate_limit_event',
      rate_limit_info: rateLimitInfo,
    });
  }

  function metaOf(update: AcpUpdate): Record<string, unknown> {
    return (update._meta ?? {}) as Record<string, unknown>;
  }

  it('emits the typed value under the rate_limit key', () => {
    // Derived from the payload rather than hardcoded to one capture's date:
    // `onePayload()` takes whichever fixture the directory lists first, so a
    // literal here asserts the fixture ORDER and breaks when one is added. The
    // seconds-to-milliseconds conversion is pinned against real dates in its
    // own test above; what this one is for is that the mapper emits the typed
    // value at all, under the right key.
    const payload = onePayload();
    const [update] = mapFrame(payload);
    expect(update.sessionUpdate).toBe('notice');

    const limit = metaOf(update)[META_RATE_LIMIT] as { resetsAtMs?: number } | undefined;
    expect(limit?.resetsAtMs).toBe((payload.resetsAt as number) * 1000);
  });

  it('on an unrecognised payload emits NO rate_limit key at all, and keeps the frame', () => {
    const payload = onePayload();
    payload.resets_at = payload.resetsAt;
    delete payload.resetsAt;

    const [update] = mapFrame(payload);
    const meta = metaOf(update);

    // Absent and explained. A zeroed or partial value here would render as an
    // empty gauge, which a human reads as plenty of headroom.
    expect(meta[META_RATE_LIMIT]).toBeUndefined();

    const unmapped = meta[META_UNMAPPED_FRAME] as { reason?: string; frame?: unknown };
    expect(unmapped.reason).toBe('rate_limit payload not recognised');
    expect(unmapped.frame).toEqual({ type: 'rate_limit_event', rate_limit_info: payload });
  });

  it('still emits the user-facing notice when the payload is unrecognised', () => {
    // Being rate-limited is worth telling a human about whether or not this
    // package understood the detail.
    const [update] = mapFrame({ nothing: 'recognisable' });
    expect(update.sessionUpdate).toBe('notice');
    expect((update.notice as { level: string }).level).toBe('warning');
  });
});
