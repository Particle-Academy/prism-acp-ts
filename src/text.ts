export interface SanitizedProviderText {
  readonly text: string;
  readonly changed: boolean;
}

/** Remove terminal escape sequences and non-whitespace control characters. */
export function stripAnsiControlSequences(value: string): SanitizedProviderText {
  let output = '';
  let index = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);

    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = skipCsi(value, index + 2);
      } else if (next === 0x5d) {
        index = skipControlString(value, index + 2, true);
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipControlString(value, index + 2, false);
      } else {
        index = skipEscape(value, index + 1);
      }
      continue;
    }

    if (code === 0x9b) {
      index = skipCsi(value, index + 1);
      continue;
    }
    if (code === 0x9d) {
      index = skipControlString(value, index + 1, true);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipControlString(value, index + 1, false);
      continue;
    }

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // Keep ordinary text layout while removing other C0 and all C1 controls.
      if (code === 0x09 || code === 0x0a || code === 0x0d) output += value[index];
      index += 1;
      continue;
    }

    output += value[index];
    index += 1;
  }

  return { text: output, changed: output !== value };
}

/**
 * Characters a reader cannot see, or that rewrite what they see: C0 controls except tab and line feed (so ESC, CR and
 * backspace are included), DEL, C1 controls, every format character (`\p{Cf}`: zero-width marks, bidi embeddings,
 * overrides and isolates, tag characters, soft hyphen, BOM), variation selectors, the combining grapheme joiner,
 * Mongolian variation selectors, the braille blank, Hangul fillers, the line/paragraph separators, and lone
 * surrogates (which cannot be encoded as UTF-8). The hidden set is the ecosystem's `markVisible` set (prism-graph,
 * PHP `Support\Visible`), plus the controls, because this text is a provider's and was never cleaned upstream.
 */
const HIDDEN = /[\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}-\u{009F}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{034F}\u{180B}-\u{180F}\u{2800}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2028}\u{2029}\u{D800}-\u{DFFF}]/gu;

/**
 * Make hidden and control characters VISIBLE, as `<U+XXXX>`, instead of removing them: a reader of untrusted provider
 * text can then see that something was there, and nothing invisible reorders or hides the text around it.
 */
export function markVisible(value: string): string {
  return value.replace(HIDDEN, (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
}

/** The most UTF-16 code units one piece of untrusted provider text keeps, after marking, before the marker. */
export const MAX_PROVIDER_TEXT_CHARS = 2048;

/** Appended to provider text cut at {@link MAX_PROVIDER_TEXT_CHARS}. */
export const PROVIDER_TEXT_TRUNCATED = '…[truncated]';

/**
 * Untrusted provider text, made safe to show: hidden and control characters marked ({@link markVisible}), then bounded
 * to `max` code units with {@link PROVIDER_TEXT_TRUNCATED} appended when cut. The cut never splits a surrogate pair or
 * a `<U+XXXX>` mark, so the result is always well-formed and never ends in half a mark.
 */
export function boundProviderText(value: string, max = MAX_PROVIDER_TEXT_CHARS): string {
  const marked = markVisible(value);
  if (marked.length <= max) return marked;
  let cut = marked.slice(0, max);
  const mark = cut.lastIndexOf('<U+');
  if (mark !== -1 && !cut.includes('>', mark)) cut = cut.slice(0, mark);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + PROVIDER_TEXT_TRUNCATED;
}

function skipCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function skipControlString(value: string, start: number, allowBell: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((allowBell && code === 0x07) || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
}

function skipEscape(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x30 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x2f) return index;
    index += 1;
  }
  return value.length;
}
