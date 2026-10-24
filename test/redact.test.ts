import { describe, expect, it } from 'vitest';
import { REDACTED, SecretRedactor } from '../src/redact.js';

const KEY = 'sk-ant-api03-fixture-only-0123456789';

/** Every split of `text` into two chunks, plus one character at a time. */
function released(text: string, chunks: string[]): string {
  const redactor = new SecretRedactor(KEY);

  return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.end();
}

describe('SecretRedactor', () => {
  const text = `error: invalid x-api-key ${KEY}\nretrying with ${KEY}.\n`;

  it('removes every whole occurrence', () => {
    expect(released(text, [text])).toBe(`error: invalid x-api-key ${REDACTED}\nretrying with ${REDACTED}.\n`);
  });

  it('removes an occurrence split at every possible point', () => {
    for (let at = 0; at <= text.length; at++) {
      const out = released(text, [text.slice(0, at), text.slice(at)]);
      expect(out, `split at ${at}`).not.toContain(KEY.slice(0, 12));
      expect(out).toBe(`error: invalid x-api-key ${REDACTED}\nretrying with ${REDACTED}.\n`);
    }
  });

  it('removes an occurrence arriving one character at a time', () => {
    const out = released(text, [...text]);
    expect(out).not.toContain(KEY.slice(0, 12));
    expect(out).toBe(`error: invalid x-api-key ${REDACTED}\nretrying with ${REDACTED}.\n`);
  });

  it('withholds a dangling start of the key when the stream ends', () => {
    expect(released('cut off: sk-ant-api03', ['cut off: ', 'sk-ant-api03'])).toBe(`cut off: ${REDACTED}`);
  });

  it('releases text that cannot be the key at once, and keeps short look-alikes', () => {
    const redactor = new SecretRedactor(KEY);
    expect(redactor.push('plain diagnostic line\n')).toBe('plain diagnostic line\n');
    expect(redactor.push('ends in sk')).toBe('ends in ');
    expect(redactor.push('y blue\n')).toBe('sky blue\n');
    expect(redactor.push('s')).toBe('');
    expect(redactor.end()).toBe('s');
  });

  it('keeps Unicode around the key intact', () => {
    expect(released(`€ ${KEY} 日本`, ['€ ', KEY.slice(0, 5), `${KEY.slice(5)} 日本`])).toBe(`€ ${REDACTED} 日本`);
  });

  it('refuses an empty secret', () => {
    expect(() => new SecretRedactor('')).toThrow();
  });
});
