import { describe, expect, it } from 'vitest';
import {
  META_NS,
  META_RATE_LIMIT,
  META_THINKING_SIGNATURE,
  META_THINKING_TOKENS_ESTIMATE,
  META_UNMAPPED_FRAME,
  RESERVED_META_KEYS,
  metaKey,
  withMeta,
} from '../src/meta.js';

describe('namespacing', () => {
  it('namespaces every key', () => {
    expect(metaKey('thing')).toBe(`${META_NS}/thing`);
  });

  it('refuses to shadow a key ACP reserves for W3C trace context', () => {
    // These live at the ROOT of _meta, unnamespaced, which is exactly why a
    // careless writer could stamp on one.
    for (const reserved of RESERVED_META_KEYS) {
      expect(() => metaKey(reserved)).toThrow(/reserved/);
    }
  });

  it('refuses a name that would forge its own namespace', () => {
    expect(() => metaKey('other.org/thing')).toThrow(/must not contain/);
  });

  it('refuses an empty name', () => {
    expect(() => metaKey('')).toThrow();
  });

  it('gives every declared key our namespace', () => {
    for (const key of [
      META_THINKING_SIGNATURE,
      META_THINKING_TOKENS_ESTIMATE,
      META_RATE_LIMIT,
      META_UNMAPPED_FRAME,
    ]) {
      expect(key.startsWith(`${META_NS}/`)).toBe(true);
    }
  });

  it('keeps the declared keys distinct', () => {
    const keys = [
      META_THINKING_SIGNATURE,
      META_THINKING_TOKENS_ESTIMATE,
      META_RATE_LIMIT,
      META_UNMAPPED_FRAME,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the estimate is kept away from measured usage', () => {
  it('does not name itself as usage', () => {
    // The decision this file exists for: an estimate must not be summable with
    // measurements. If anyone later renames this key to something usage-shaped,
    // this fails and they have to read the reasoning first.
    expect(META_THINKING_TOKENS_ESTIMATE).toContain('estimate');
    expect(META_THINKING_TOKENS_ESTIMATE).not.toMatch(/^.*\/(input|output)_tokens$/);
  });
});

describe('withMeta', () => {
  it('attaches entries without disturbing the object', () => {
    const update = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } };
    const out = withMeta(update, { [META_THINKING_SIGNATURE]: 'sig' });
    expect(out.sessionUpdate).toBe('agent_thought_chunk');
    expect(out.content).toEqual({ type: 'text', text: 'x' });
    expect(out._meta[META_THINKING_SIGNATURE]).toBe('sig');
  });

  it('does not mutate its input', () => {
    const update = { sessionUpdate: 'notice' };
    withMeta(update, { a: 1 });
    expect('_meta' in update).toBe(false);
  });

  it('MERGES with existing _meta rather than replacing it', () => {
    // Two mapping sites can both have something to say about one notification,
    // and the second must not erase the first. This is the same collision that
    // cost a peer implementation a permanently parked agent when one permission
    // overwrote another.
    const once = withMeta({ sessionUpdate: 'notice' }, { [META_RATE_LIMIT]: { retryMs: 600 } });
    const twice = withMeta(once, { [META_UNMAPPED_FRAME]: { subtype: 'status' } });
    expect(twice._meta[META_RATE_LIMIT]).toEqual({ retryMs: 600 });
    expect(twice._meta[META_UNMAPPED_FRAME]).toEqual({ subtype: 'status' });
  });

  it('keeps a trace-context key an outer layer already set', () => {
    // We never write these, but a caller or a tracing layer may have, and
    // merging must not drop them.
    const traced = { sessionUpdate: 'notice', _meta: { traceparent: '00-abc-def-01' } };
    const out = withMeta(traced, { [META_RATE_LIMIT]: {} });
    expect(out._meta.traceparent).toBe('00-abc-def-01');
  });

  it('lets a later write win on the SAME key', () => {
    const out = withMeta(withMeta({}, { k: 1 }), { k: 2 });
    expect(out._meta.k).toBe(2);
  });
});
