/** Refused or failed account work. Its own module so `login.ts` and `accounts.ts` can both extend it without a cycle. */
export class ClaudeAccountError extends Error {
  override readonly name: string = 'ClaudeAccountError';
}
