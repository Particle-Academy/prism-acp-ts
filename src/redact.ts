/** What a redacted secret reads as. */
export const REDACTED = '[redacted]';

/**
 * A dangling start of the secret this long or longer is withheld when the
 * stream ends. Shorter is too short to identify a key and too common to hide.
 */
const DANGLING_MINIMUM = 4;

/**
 * Removes every occurrence of one secret from a stream of text chunks,
 * including an occurrence split across chunks.
 *
 * Only the tail that could still be the start of the secret is held back, and
 * only until the next chunk shows whether it is. Text that cannot be part of
 * the secret is released at once, so diagnostics are not delayed.
 */
export class SecretRedactor {
  readonly #secret: string;
  #held = '';

  constructor(secret: string) {
    if (secret.length === 0) throw new Error('a secret to redact cannot be empty');
    this.#secret = secret;
  }

  /** The text that is now safe to release. */
  push(chunk: string): string {
    const text = (this.#held + chunk).split(this.#secret).join(REDACTED);
    const keep = this.#pendingPrefix(text);
    this.#held = text.slice(text.length - keep);

    return text.slice(0, text.length - keep);
  }

  /** The stream ended: release what was held, withholding a dangling start of the secret. */
  end(): string {
    const tail = this.#held;
    this.#held = '';

    return tail.length >= DANGLING_MINIMUM ? REDACTED : tail;
  }

  /** The length of the longest suffix of `text` that the secret starts with. */
  #pendingPrefix(text: string): number {
    for (let length = Math.min(text.length, this.#secret.length - 1); length > 0; length--) {
      if (this.#secret.startsWith(text.slice(text.length - length))) return length;
    }

    return 0;
  }
}
