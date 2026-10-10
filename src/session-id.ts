/** Provider session ids cross from untrusted frames into resume requests/argv. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidCliSessionId(value: unknown): value is string {
  // Require a full match defensively against future regex or flag changes.
  return typeof value === 'string' && SESSION_ID.exec(value)?.[0] === value;
}
