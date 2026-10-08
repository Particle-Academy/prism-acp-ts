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
