import { describe, expect, it } from 'vitest';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import { readRateLimit } from '../src/claude/rate-limit.js';
import { ClaudeTurnFailures, codexFailureOf } from '../src/turn-failure.js';

/**
 * A NAME THE PROVIDER CHOSE IS LOOKED UP AS DATA, NEVER THROUGH THE OBJECT PROTOTYPE (G-96), AND A RESET JAVASCRIPT
 * CANNOT HOLD AS A DATE IS REFUSED, NOT THROWN (G-97). Found by running the captures and hostile mutations of them
 * through this package and the PHP port side by side; every expectation below was the reference's answer before.
 *
 * The frames are parsed from JSON TEXT on purpose: an object literal's `__proto__` key sets the prototype instead of
 * creating a property, so it could not reproduce what a provider's line produces.
 */
const parse = (text: string): unknown => JSON.parse(text);
const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

describe('G-96: provider names are looked up as data', () => {
  it.each(NAMES)('a tool named %s is announced with no kind, not with whatever Object.prototype has', (name) => {
    const mapper = new ClaudeToAcp();
    const streamed = mapper.frame({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name } },
    });
    const subagent = mapper.frame(parse(
      `{"type":"assistant","parent_tool_use_id":"p","message":{"content":[{"type":"tool_use","id":"t2","name":${JSON.stringify(name)},"input":{}}]}}`,
    ));
    for (const update of [...streamed, ...subagent]) {
      expect(Object.hasOwn(update, 'kind')).toBe(false);
      expect(JSON.stringify(update)).not.toContain('"kind"');
    }
  });

  it.each(NAMES)('a turn failure whose reason is %s has the kind "other", which survives JSON', (reason) => {
    const tracker = new ClaudeTurnFailures();
    tracker.observe({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [] }, error: reason });
    expect(JSON.parse(JSON.stringify(tracker.take()))).toEqual({ reason, kind: 'other' });
    expect(JSON.parse(JSON.stringify(codexFailureOf({ codexErrorInfo: reason })))).toEqual({ reason, kind: 'other' });
  });

  it('a window the provider named __proto__ is a window: it reaches _meta, as the notice already said', () => {
    const read = readRateLimit(parse(
      '{"status":"allowed","resetsAt":1700000000,"rateLimitType":"__proto__","unifiedWindows":{"__proto__":{"utilization":0.5,"resetsAt":1700000001}}}',
    ));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.stringify(read.limit.windows)).toBe('{"__proto__":{"utilization":0.5,"resetsAtMs":1700000001000}}');
    const [update] = new ClaudeToAcp().frame(parse(
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1700000000,"rateLimitType":"__proto__","unifiedWindows":{"__proto__":{"utilization":0.5,"resetsAt":1700000001}}}}',
    ));
    expect(JSON.stringify(update)).toContain('"windows":{"__proto__":{"utilization":0.5,"resetsAtMs":1700000001000}}');
  });

  it.each(['toString', 'hasOwnProperty', 'constructor'])('a binding window named %s that was not reported is absent, never "NaN% used"', (type) => {
    const [update] = new ClaudeToAcp().frame({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1700000000, rateLimitType: type, unifiedWindows: {} },
    });
    expect((update as { notice: { message: string } }).notice.message)
      .toBe(`Rate limit: ${type} window, resets 2023-11-14T22:13:20.000Z.`);
  });
});

describe('G-97: a reset past JavaScript\'s last date is refused, not thrown', () => {
  const frame = (top: number, window: number) => ({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: top, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: window } } },
  });

  it.each([
    ['the top-level reset', frame(1e13, 1700000000), 'rate_limit: resetsAt expected valid epoch seconds representable as a JavaScript date, got 10000000000000'],
    ['a window\'s reset', frame(1700000000, 1e13), 'rate_limit: unifiedWindows.five_hour.resetsAt expected valid epoch seconds representable as a JavaScript date, got 10000000000000'],
  ])('%s: the frame maps to the unmapped notice, with the field named', (_, input, reason) => {
    const updates = new ClaudeToAcp().frame(input);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: 'notice',
      _meta: { 'particle.academy/unmapped_frame': { reason } },
    });
  });

  it('the last representable second is still read', () => {
    expect(readRateLimit(frame(8.64e12, 8.64e12).rate_limit_info).ok).toBe(true);
    expect(new ClaudeToAcp().frame(frame(8.64e12, 8.64e12))[0]).toMatchObject({
      notice: { message: 'Rate limit: five_hour window at 100% used, resets +275760-09-13T00:00:00.000Z.' },
    });
  });

  it('a turn failure observing such an event does not throw either', () => {
    const tracker = new ClaudeTurnFailures();
    expect(() => tracker.observe(frame(1e13, 1e13))).not.toThrow();
  });
});
