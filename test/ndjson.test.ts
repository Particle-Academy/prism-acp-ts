import { describe, expect, it } from 'vitest';
import { MAX_LINE_BYTES, NdjsonFramer, encodeLine, parseLine, type Frame } from '../src/ndjson.js';

const utf8 = new TextEncoder();

function framesOf(chunks: Array<Uint8Array | string>) {
  const framer = new NdjsonFramer();
  const out = chunks.flatMap((chunk) => framer.push(chunk));
  return [...out, ...framer.end()];
}

describe('framing', () => {
  it('reads one line', () => {
    expect(framesOf(['{"a":1}\n'])).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('reads a line that arrives across chunks', () => {
    expect(framesOf(['{"a', '":1}', '\n'])).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('reads several lines from one chunk', () => {
    const frames = framesOf(['{"a":1}\n{"b":2}\n']);
    expect(frames.map((f) => (f.ok ? f.value : f.error))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('keeps a trailing line that never got its newline', () => {
    // A producer can exit without a final newline. Dropping that line loses
    // the `result` frame, which is the one carrying the outcome.
    expect(framesOf(['{"a":1}'])).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('skips blank lines rather than failing on them', () => {
    expect(framesOf(['\n', '  \n', '{"a":1}\n', '\n'])).toEqual([{ ok: true, value: { a: 1 } }]);
  });
});

describe('decision 1 — a trailing \\r is stripped, not left to the parser', () => {
  it('parses a CRLF-framed stream', () => {
    expect(framesOf(['{"a":1}\r\n{"b":2}\r\n']).every((f) => f.ok)).toBe(true);
  });

  it('strips the \\r rather than depending on JSON.parse tolerating it', () => {
    // The point of the decision: this must hold for a port whose parser is
    // stricter than V8's, so it is asserted at the line level where the
    // stripping happens, not only through a stream that might mask it.
    expect(parseLine('{"a":1}\r')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('treats a \\r-only line as blank', () => {
    expect(parseLine('\r')).toBeNull();
  });
});

describe('decision 2 — the byte cap is the same number everywhere', () => {
  it('is 64_000_000', () => {
    // Pinned deliberately: a cap that differs per port means one
    // implementation dies where another succeeds on the same stream.
    expect(MAX_LINE_BYTES).toBe(64_000_000);
  });

  it('accepts a line just under the cap', () => {
    const payload = 'x'.repeat(MAX_LINE_BYTES - 20);
    const frame = parseLine(JSON.stringify({ a: payload }));
    expect(frame?.ok).toBe(true);
  });

  it('refuses a completed line over the cap', () => {
    const frame = parseLine(JSON.stringify({ a: 'x'.repeat(MAX_LINE_BYTES) }));
    expect(frame?.ok).toBe(false);
    if (frame && !frame.ok) expect(frame.error.kind).toBe('oversize');
  });

  it('refuses an UNTERMINATED line over the cap instead of buffering forever', () => {
    // The cap has to apply while a line is still accumulating. Checked only on
    // completion, a producer emitting an endless line with no newline grows the
    // buffer without bound and the cap is never reached -- correct, and useless.
    const framer = new NdjsonFramer();
    const half = 'x'.repeat(MAX_LINE_BYTES / 2 + 100_000);
    expect(framer.push(half)).toEqual([]);
    const frames = framer.push(half);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.ok).toBe(false);
  });

  it('measures the cap in BYTES, not UTF-16 code units', () => {
    // Ideographs are 3 bytes each: this line is UNDER the cap in UTF-16 units and OVER it in bytes. A port
    // measuring `.length` would accept this and then disagree with a port
    // measuring bytes -- the exact split this pinning exists to prevent.
    const units = Math.floor(MAX_LINE_BYTES / 3) + 10;
    expect(units).toBeLessThan(MAX_LINE_BYTES);
    const frame = parseLine(JSON.stringify({ a: '漢'.repeat(units) }));
    expect(frame?.ok).toBe(false);
  });
});

describe('decision 3 — a framing error reports size, never content', () => {
  const secret = 'sk-ant-SUPERSECRET-DO-NOT-LOG';

  it('withholds the content of an oversized line', () => {
    const frame = parseLine(JSON.stringify({ k: secret + 'x'.repeat(MAX_LINE_BYTES) }));
    expect(frame?.ok).toBe(false);
    if (frame && !frame.ok) {
      expect(frame.error.message).not.toContain(secret);
      expect(frame.error.message).not.toContain('sk-ant');
      expect(frame.error.bytes).toBeGreaterThan(MAX_LINE_BYTES);
    }
  });

  it('withholds the content of an unparseable line', () => {
    // JSON.parse's own message quotes the input, which is why `cause.message`
    // is deliberately not forwarded. Without this assertion that forwarding
    // could be reintroduced by anyone trying to make the error friendlier.
    const frame = parseLine(`{"k":"${secret}"` /* truncated: no closing brace */);
    expect(frame?.ok).toBe(false);
    if (frame && !frame.ok) {
      expect(frame.error.kind).toBe('invalid-json');
      expect(frame.error.message).not.toContain(secret);
      expect(frame.error.message).not.toContain('sk-ant');
    }
  });

  it('still reports the byte size, so the error is diagnosable', () => {
    // Withholding content must not mean withholding everything: a bare "bad
    // frame" with no size is indistinguishable from a transport that produced
    // nothing, which is the failure this estate keeps finding.
    const frame = parseLine('{nope');
    expect(frame?.ok).toBe(false);
    if (frame && !frame.ok) expect(frame.error.bytes).toBe(5);
  });
});

describe('UTF-8 across chunk boundaries', () => {
  it('does not corrupt a character split between chunks', () => {
    // Streaming decode is not an optimisation. A chunk boundary landing
    // mid-character substitutes U+FFFD and the JSON is silently wrong -- and
    // it stays invisible until a non-ASCII payload appears in production.
    const bytes = utf8.encode('{"a":"漢字"}\n');
    const frames = framesOf([bytes.slice(0, 8), bytes.slice(8)]);
    expect(frames).toEqual([{ ok: true, value: { a: '漢字' } }]);
  });
});

describe('encodeLine', () => {
  it('round-trips through the framer', () => {
    const value = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    expect(framesOf([encodeLine(value)])).toEqual([{ ok: true, value }]);
  });
});

describe('framing cost is proportional to the bytes pushed', () => {
  // A large frame arriving in many chunks used to re-measure and re-search the
  // whole pending line on every chunk, which is quadratic and froze a host's
  // main thread for seconds at a time. These pin the behaviour the fix keeps.

  const sample = (n: number): string => {
    const parts = ['a', 'é', '中', '😀', '\uD800', '\uDC00', '"', '\\', ' '];
    let s = '';
    for (let i = 0; i < n; i++) s += parts[(i * 7 + 3) % parts.length];
    return s;
  };

  it('frames identically however the stream is chunked', () => {
    const lines = [{ a: 1 }, { text: sample(500) }, { b: [1, 2, 3] }, { text: sample(37) }];
    const stream = new TextEncoder().encode(lines.map((value) => encodeLine(value)).join(''));
    const expected = lines.map((value) => JSON.parse(new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(value)))));

    for (const size of [1, 2, 3, 7, 64, 1000, stream.length]) {
      const framer = new NdjsonFramer();
      const frames: Frame[] = [];
      for (let offset = 0; offset < stream.length; offset += size) frames.push(...framer.push(stream.subarray(offset, offset + size)));
      frames.push(...framer.end());
      expect(frames.map((frame) => (frame.ok ? frame.value : frame.error.kind))).toEqual(expected);
    }
  });

  it('counts pending bytes exactly as TextEncoder would, including surrogates', () => {
    const unit = '中😀\uD800';
    const perUnit = new TextEncoder().encode(unit).length;
    const repeat = Math.floor(MAX_LINE_BYTES / perUnit) + 1;
    const frames = new NdjsonFramer().push(unit.repeat(repeat));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, error: { kind: 'oversize', bytes: perUnit * repeat } });
  });

  it('keeps counting a pending line across chunks and refuses it once it passes the cap', () => {
    const framer = new NdjsonFramer();
    const chunk = 'x'.repeat(4_000_000);
    const frames: Frame[] = [];
    for (let i = 0; i < 17; i++) frames.push(...framer.push(chunk));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, error: { kind: 'oversize', bytes: 68_000_000 } });
  });

  it('starts counting afresh after a newline', () => {
    const framer = new NdjsonFramer();
    const half = 'x'.repeat(40_000_000);
    expect(framer.push(`"${half}"\n"`)).toHaveLength(1);
    expect(framer.push(`${half}"\n`)).toEqual([{ ok: true, value: half }]);
  });
});
