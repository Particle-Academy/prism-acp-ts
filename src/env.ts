/**
 * The environment handed to a spawned agent CLI.
 *
 * This module exists because of a measured failure, not a theoretical one.
 *
 * An agent CLI driven on a consumer subscription carries no API key -- auth
 * lives in the CLI's own store. But the SDK behind it resolves credentials from
 * an ORDERED list, and `ANTHROPIC_API_KEY` comes first. So a key inherited from
 * the surrounding environment does not lose to the subscription: it OUTRANKS
 * it. The CLI says so itself:
 *
 *   > claude.ai connectors are disabled because ANTHROPIC_API_KEY or another
 *   > auth source is set and takes precedence over your claude.ai login
 *
 * Two failure modes follow, and the second is the one that was actually
 * observed on a developer workstation while this package was being written:
 *
 *   - A VALID inherited key bills per token while the interface reports a
 *     subscription session. Wrong, expensive, and reporting success.
 *   - An INVALID inherited key makes every call fail `401
 *     authentication_failed` and retry to exhaustion -- it does NOT fall back
 *     to the working subscription login, because precedence is resolved before
 *     validity is tested. The 401 then points a reader at their account, one
 *     layer below the actual cause.
 *
 * ## Why an allow-list and not a deny-list
 *
 * A deny-list naming today's credential variables is one new provider variable
 * away from being wrong again -- and wrong in the direction that spends money
 * silently. An allow-list is wrong in the direction that fails loudly, with a
 * missing variable and an error. When a guard can err in two directions, take
 * the one that produces an error over the one that produces a plausible result.
 *
 * ## Why this is per-spawn and never ambient
 *
 * The surrounding workspace may hold an API key ON PURPOSE -- other consumers
 * in the same project legitimately bill per token. So this builds the CHILD's
 * environment and never mutates `process.env`. An adapter that "cleaned" the
 * ambient environment would fix its own call and silently break every other
 * consumer beside it: the same mistake in the opposite direction, wearing the
 * disguise of tidying up.
 */

/**
 * Credentials that outrank a CLI's own subscription login.
 *
 * Compared case-INSENSITIVELY. On Windows environment variable names are
 * case-insensitive, so `anthropic_api_key` reaches the child exactly as
 * `ANTHROPIC_API_KEY` does while sailing past any case-sensitive comparison.
 * A guard that only catches the conventional spelling is a guard against
 * tidiness, not against the failure.
 */
export const OUTRANKING_CREDENTIALS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'CLAUDE_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

/**
 * What a CLI needs in order to run at all.
 *
 * Deliberately boring: process lookup, a home directory, a temp directory,
 * locale, and proxy settings. Anything a particular agent needs beyond this is
 * passed explicitly by the caller, where it is visible in a diff.
 */
export const BASE_ALLOW: readonly string[] = [
  // POSIX
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'USER',
  'LOGNAME',
  // Windows
  'APPDATA',
  'COMSPEC',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  // Networking, on both
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
];

export interface ChildEnvOptions {
  /** Extra variable names to pass through, beyond {@link BASE_ALLOW}. */
  readonly allow?: readonly string[];
  /** Variables to set explicitly. Applied after the allow-list, so these win. */
  readonly set?: Readonly<Record<string, string>>;
  /**
   * Pass an outranking credential through anyway.
   *
   * Named at this length on purpose. Billing a subscription user per token is
   * not something anyone should be able to switch on while reaching for
   * something else, so it cannot be done by adding a name to `allow` -- that
   * path is refused even when the name is listed.
   */
  readonly allowSubscriptionOverridingCredentials?: boolean;
}

export interface ChildEnvResult {
  /** The environment to hand to the child. */
  readonly env: Record<string, string>;
  /**
   * Names of outranking credentials found in the parent and withheld.
   *
   * Returned rather than logged: the caller decides whether to surface it, and
   * the NAMES are safe to show while the values never leave the parent.
   */
  readonly withheld: readonly string[];
}

/**
 * Build a child environment allow-list-first.
 *
 * Never reads, copies, logs or returns a credential VALUE -- only the names it
 * refused to pass on.
 */
export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  options: ChildEnvOptions = {},
): ChildEnvResult {
  const outranking = new Set(OUTRANKING_CREDENTIALS.map(upper));
  const allowed = new Set([...BASE_ALLOW, ...(options.allow ?? [])].map(upper));

  const env: Record<string, string> = {};
  const withheld: string[] = [];

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;

    const key = upper(name);

    if (outranking.has(key)) {
      // Refused even when the caller listed it in `allow`. The only way past
      // is the explicitly-named option, so "I added it to the allow-list" can
      // never be the accidental cause of a per-token bill.
      if (options.allowSubscriptionOverridingCredentials === true) {
        env[name] = value;
      } else {
        withheld.push(name);
      }
      continue;
    }

    if (allowed.has(key)) env[name] = value;
  }

  // Explicit values last: a caller setting something deliberately outranks
  // whatever the parent happened to contain.
  for (const [name, value] of Object.entries(options.set ?? {})) {
    env[name] = value;
  }

  return { env, withheld };
}

/**
 * Case-fold an environment variable name for comparison.
 *
 * Every name comparison in this module goes through here, so the
 * case-insensitivity is one decision in one place rather than a convention that
 * holds until somebody adds a comparison that forgets it.
 */
function upper(name: string): string {
  return name.toUpperCase();
}
