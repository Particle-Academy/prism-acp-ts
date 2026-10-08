import { describe, expect, it } from 'vitest';
import { stripAnsiControlSequences } from '../src/text.js';

describe('stripAnsiControlSequences', () => {
  it('removes a real CSI color sequence', () => {
    expect(stripAnsiControlSequences('\u001b[31mred\u001b[0m')).toEqual({
      text: 'red',
      changed: true,
    });
  });

  it('removes an 8-bit C1 CSI sequence', () => {
    expect(stripAnsiControlSequences('\u009b2Kvisible')).toEqual({
      text: 'visible',
      changed: true,
    });
  });

  it('removes an 8-bit OSC terminated by C1 ST', () => {
    expect(stripAnsiControlSequences('before\u009d0;title\u009cafter')).toEqual({
      text: 'beforeafter',
      changed: true,
    });
  });

  it('removes a bare ESC and its unterminated sequence', () => {
    expect(stripAnsiControlSequences('before\u001b')).toEqual({
      text: 'before',
      changed: true,
    });
  });

  it('returns escape-free text byte for byte unchanged', () => {
    const text = 'plain\tUnicode λ and CRLF\r\n';
    const result = stripAnsiControlSequences(text);
    expect(result.text).toBe(text);
    expect(result.changed).toBe(false);
  });
});
