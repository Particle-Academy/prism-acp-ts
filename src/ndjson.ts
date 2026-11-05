/**
 * NDJSON framing for the Agent Client Protocol.
 *
 * One JSON value per line, newline-delimited, over a pipe. Nothing here is
 * clever; everything here is PINNED, because this package exists in three
 * languages and framing is where three implementations of the same protocol
 * disagree without anyone noticing.
 *
 * Three decisions are deliberate and must read identically in the TypeScript,
 * PHP and Python ports:
 *
 * 1. A trailing `\r` is STRIPPED, not merely tolerated by the JSON parser.
 *    `JSON.parse` happens to accept it, `json_decode` and `json.loads` happen
 *    to accept it, and a hand-rolled splitter in any of them happens not to.
 *    Relying on three parsers' leniency agreeing is not a decision, it is a
 *    coincidence waiting to end -- so the `\r` is removed before parsing and
 *    the behaviour is the same everywhere by construction.
 *
 * 2. `MAX_LINE_BYTES` is 64_000_000, the same number in every port. A cap that
 *    differs per language means one implementation dies where another succeeds,
 *    on the same stream, which is worse than either limit. The cap bounds a
 *    RUNAWAY line (a producer that never writes a newline); it is not a size
 *    budget for ordinary frames. It was 1_000_000 until a live Claude session
 *    sent a 1,036,723-byte frame -- a tool result carrying an image the agent had
 *    just read -- and the frame was dropped (Genie 2, 2026-10-14).
 *
 * 3. An oversized or unparseable line reports its SIZE, never its CONTENT. A
 *    line on this transport can carry a prompt, a file, or a credential, and a
 *    framing error is not a reason to copy it into a log.
 *
 * Blank lines are skipped. NDJSON producers emit them at flush boundaries and
 * they carry no value; treating one as a parse error would make a correct
 * stream look broken.
 */

/** The same number in every port. See decision 2 above. */
export const MAX_LINE_BYTES = 64_000_000;

export type Frame =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: FrameError };

export interface FrameError {
  /** `oversize` when the cap was hit, `invalid-json` when parsing failed. */
  readonly kind: 'oversize' | 'invalid-json';
  /** Byte length of the offending line. Reported INSTEAD of its content. */
  readonly bytes: number;
  /** Safe to log: never contains any part of the line. */
  readonly message: string;
}

/**
 * Splits a byte stream into NDJSON frames.
 *
 * Stateful by necessity -- a line can arrive across any number of chunks, and
 * a reader that assumed chunk boundaries were line boundaries would work on
 * every small message and fail on the first large one.
 */
export class NdjsonFramer {
  #buffer = '';
  /** UTF-8 byte length of `#buffer`, kept incrementally so each push costs O(chunk), not O(pending line). */
  #pendingBytes = 0;
  #decoder = new TextDecoder('utf-8');

  /**
   * Feed one chunk. Returns every frame completed by it, which may be none.
   *
   * The decoder runs in streaming mode (`stream: true`) so a multi-byte
   * character split across two chunks is held rather than replaced with U+FFFD.
   * Without it, a chunk boundary landing mid-character silently corrupts the
   * JSON -- and the corruption is invisible until a non-ASCII payload appears.
   */
  push(chunk: Uint8Array | string): Frame[] {
    return this.#append(typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true }));
  }

  /**
   * Finish the stream. Returns any frame left in the buffer.
   *
   * A producer that exits without a trailing newline has still sent a complete
   * line, and dropping it would lose the last message of every such stream --
   * most importantly a `result` frame, which is the one that carries the
   * outcome.
   */
  end(): Frame[] {
    const frames = this.#append(this.#decoder.decode());
    const rest = this.#buffer;
    this.#buffer = '';
    this.#pendingBytes = 0;
    const frame = rest.length > 0 ? parseLine(rest) : null;
    return frame === null ? frames : [...frames, frame];
  }

  /**
   * Add decoded text and return the frames it completes.
   *
   * Work is proportional to the TEXT ADDED, never to the line pending before it.
   * The buffer held no newline before this call, so only the new text is
   * searched; and the pending byte count is updated from the new text alone.
   * Re-measuring or re-searching the whole pending line on every chunk made a
   * large frame quadratic in its number of chunks (genie: 7-18 s main-thread
   * stalls on long session-replay lines).
   */
  #append(text: string): Frame[] {
    const frames: Frame[] = [];
    if (text.length === 0) return frames;

    let newline = text.indexOf('\n');
    if (newline === -1) {
      this.#buffer += text;
      this.#pendingBytes += utf8Length(text);
    } else {
      // The first newline completes the pending line.
      let start = 0;
      while (newline !== -1) {
        const line = start === 0 ? this.#buffer + text.slice(0, newline) : text.slice(start, newline);
        const frame = parseLine(line);
        if (frame !== null) frames.push(frame);
        start = newline + 1;
        newline = text.indexOf('\n', start);
      }
      this.#buffer = text.slice(start);
      this.#pendingBytes = utf8Length(this.#buffer);
    }

    // The cap applies to a line still being accumulated, not only to a
    // completed one. Checking it only on completion would mean a producer
    // emitting an endless line without a newline grows the buffer forever --
    // the cap would be correct and never reached.
    if (this.#pendingBytes > MAX_LINE_BYTES) {
      const pending = this.#pendingBytes;
      this.#buffer = '';
      this.#pendingBytes = 0;
      frames.push(oversize(pending));
    }

    return frames;
  }
}

/**
 * Parse one line. Returns null for a blank line, which is not an error.
 *
 * Exported because the framing decisions have to be assertable without
 * constructing a stream: a test that can only reach this through `push` is
 * testing both at once and localises nothing.
 */
export function parseLine(line: string): Frame | null {
  // Decision 1: strip, do not rely on the parser tolerating it.
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text.trim().length === 0) return null;

  const bytes = byteLength(text);
  if (bytes > MAX_LINE_BYTES) return oversize(bytes);

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    // Decision 3: the reason, never the line. `cause.message` from JSON.parse
    // can itself quote the input, so it is deliberately not forwarded.
    void cause;
    return {
      ok: false,
      error: {
        kind: 'invalid-json',
        bytes,
        message: `NDJSON frame is not valid JSON (${bytes} bytes; content withheld)`,
      },
    };
  }
}

function oversize(bytes: number): Frame {
  return {
    ok: false,
    error: {
      kind: 'oversize',
      bytes,
      message: `NDJSON frame exceeds ${MAX_LINE_BYTES} bytes (${bytes} bytes; content withheld)`,
    },
  };
}

/** UTF-8 byte length, because the cap is in bytes and `.length` is in UTF-16 code units. */
function byteLength(text: string): number {
  return utf8Length(text);
}

/**
 * UTF-8 length without encoding, so measuring allocates nothing. Matches
 * `TextEncoder`: a surrogate pair is 4 bytes, and a lone surrogate is encoded
 * as U+FFFD, 3 bytes.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Serialise one value as an NDJSON line, trailing newline included. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
