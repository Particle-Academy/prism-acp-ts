/**
 * WHICH CLAUDE ACCOUNT A LAUNCH USES, chosen by the host, never by holding a credential.
 *
 * Claude Code keeps one sign-in per configuration directory. Anthropic documents this as the way to stay signed in to
 * several accounts at once (https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts):
 *
 *   > give each account its own configuration directory. When you start `claude`, set the `CLAUDE_CONFIG_DIR`
 *   > environment variable to the directory for the account you want to use. Each directory has its own settings,
 *   > session history, and claude.ai login or API key.
 *
 * So an "account" here is a directory path. The host stores a label, the path, and the email or organisation the CLI
 * itself reported. This module stores nothing, and it never opens a file under the directory: what is signed in there
 * is asked of the CLI (`claude auth status --json`), and signing in is the CLI's own flow, run by the person in a
 * terminal they can see (`claude auth login`). Anthropic's terms forbid the alternative outright
 * (https://code.claude.com/docs/en/legal-and-compliance): developers "may not collect, store, or intermediate
 * Claude.ai credentials or session tokens -- sign-in to a Claude account must complete through Anthropic's own flow."
 *
 * There is no automatic switching. Switching is the host choosing which directory the NEXT launch uses; nothing here
 * reacts to a rate limit by moving to another account, because doing that without the person would need a stored key.
 *
 * Measured against claude-code 2.1.330 on Windows, 2026-11-21, without signing in (status only, empty directories and
 * deliberately invalid keys):
 *
 * - An empty directory reports `loggedIn: false, authMethod: "none"` and exits 1, with the directory it used in
 *   `configDirectory`. The CLI creates `.claude.json` and `backups/` there on first use.
 * - `ANTHROPIC_API_KEY` in the environment reports `authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY"` and hides
 *   a working subscription login completely (no email, no plan). Status does not test the key: a bogus one reads as
 *   `loggedIn: true`. `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` both read as `authMethod: "oauth_token"`.
 * - Setting CLAUDE_CONFIG_DIR to the DEFAULT directory (`~/.claude`) is not the same as leaving it unset: the CLI then
 *   looks for its global config at `~/.claude/.claude.json` instead of `~/.claude.json` and creates a fresh one. The
 *   login was still found on Windows; on macOS the Keychain entry is keyed to the directory when the variable is set.
 *   So the person's default account is `configDir: null` here, never its path.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { OUTRANKING_CREDENTIALS, childEnv } from '../env.js';
import { launchProvider, type ProcessTreeOptions } from '../process-tree.js';
import { boundProviderText, stripAnsiControlSequences } from '../text.js';

/**
 * Which configuration directory: an absolute path the host chose for one account, or `null` for the CLI's own default
 * (CLAUDE_CONFIG_DIR removed from the child, including an inherited one).
 */
export type ClaudeConfigDir = string | null;

/**
 * How the CLI would authenticate in that directory, as the CLI reports it.
 *
 * - `subscription`: a claude.ai login (Pro, Max, Ultra, Team, Enterprise). `authMethod: "claude.ai"`.
 * - `console`: an API key Claude Code saved from a Console login (`authMethod: "api_key"` with a source that is not an
 *   environment variable). INFERRED from the documented enum, not measured: measuring it would need a Console login.
 * - `apiKey`: an API key from an environment variable or `apiKeyHelper` reached the CLI anyway -- after this package
 *   withheld the inherited ones, that means a settings file set it.
 * - `none`: nothing signed in.
 * - `other`: anything else (`oauth_token`, `third_party`, a value newer than this package). `cliAuthMethod` has it.
 */
export type ClaudeAccountMethod = 'subscription' | 'console' | 'apiKey' | 'none' | 'other';

/** Who pays: the plan, per-token API billing, nobody, or something this package cannot classify. */
export type ClaudeBilling = 'subscription' | 'apiUsage' | 'none' | 'unknown';

export interface ClaudeAccountStatus {
  readonly signedIn: boolean;
  readonly method: ClaudeAccountMethod;
  /** The CLI's own `authMethod` value, kept so a value this package does not know is never silently renamed. */
  readonly cliAuthMethod: string;
  readonly billing: ClaudeBilling;
  /** Present only when the CLI prints them, which it does for a claude.ai login it is actually using. */
  readonly email?: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
  /** `max`, `pro`, ... as the CLI reports it. A billing hint, not a contract. */
  readonly subscriptionType?: string;
  /** The NAME of where an API key came from (`ANTHROPIC_API_KEY`, ...). Never a value. */
  readonly apiKeySource?: string;
  /**
   * The directory this status was ASKED for: the resolved path, or `null` when CLAUDE_CONFIG_DIR was left unset (the
   * CLI's default). `compare()` matches a selection against this, so a status for one account is never read as
   * another's.
   */
  readonly requestedConfigDir: ClaudeConfigDir;
  /** The directory the CLI says it used. */
  readonly configDirectory?: string;
  /** False when the CLI reports a different directory from the one asked for: the selection did not take effect. */
  readonly configDirectoryMatches: boolean;
  /** The latest expected end of a stored login (ISO 8601), or null. */
  readonly loginExpiresAt: string | null;
  /** Credential variable NAMES found in the parent environment and withheld from the CLI. */
  readonly withheld: readonly string[];
}

export interface ClaudeAccountOptions {
  /** The CLI to run. Default `claude`. */
  readonly binary?: string;
  readonly binaryArgs?: readonly string[];
  /**
   * Working directory. Use the session's: project settings there can set environment variables (an API key among
   * them), and status should see what the launch will see.
   */
  readonly cwd?: string;
  /** Parent environment to build the child's from. Default `process.env`. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Extra environment names to pass through. Credential names are refused here as everywhere (env.ts). */
  readonly allowEnv?: readonly string[];
  readonly processTree?: ProcessTreeOptions;
  /** How long to wait for the status. Default 15 s. */
  readonly timeoutMs?: number;
}

export class ClaudeAccountError extends Error {
  override readonly name = 'ClaudeAccountError';
}

/** The largest status this reads. The real one is well under 1 KiB. */
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 320;

/** Check a directory choice. Never touches the filesystem: the CLI creates the directory itself. */
export function claudeConfigDir(configDir: ClaudeConfigDir): string | null {
  if (configDir === null) return null;
  // eslint-disable-next-line no-control-regex
  if (typeof configDir !== 'string' || configDir.trim() === '' || /[\u0000-\u001f\u007f]/.test(configDir)) {
    throw new ClaudeAccountError('configDir must be an absolute path with no control characters, or null for the default');
  }
  if (!isAbsolute(configDir)) throw new ClaudeAccountError('configDir must be an absolute path, or null for the default');
  return resolve(configDir);
}

/**
 * The child environment for a launch in that directory: allow-list-first (env.ts), every outranking credential
 * withheld, CLAUDE_CONFIG_DIR set to the choice -- or removed, for the default.
 */
export function claudeAccountEnv(
  configDir: ClaudeConfigDir,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
  allowEnv: readonly string[] = [],
): { env: Record<string, string>; withheld: readonly string[] } {
  const dir = claudeConfigDir(configDir);
  // CLAUDE_CONFIG_DIR is never inherited here: either it is set to the choice, or the choice is the default and an
  // inherited one would silently pick another account.
  const allow = ['XDG_CONFIG_HOME', ...allowEnv.filter((name) => name.toUpperCase() !== 'CLAUDE_CONFIG_DIR')];
  return childEnv(parentEnv, { allow, ...(dir === null ? {} : { set: { CLAUDE_CONFIG_DIR: dir } }) });
}

/**
 * What is signed in, in that directory: the CLI's own `claude auth status --json`, run with the same stripped
 * environment a launch gets. No file is read; no credential passes through here, because the status carries none.
 */
export async function describeClaudeAccount(configDir: ClaudeConfigDir, options: ClaudeAccountOptions = {}): Promise<ClaudeAccountStatus> {
  const dir = claudeConfigDir(configDir);
  const { env, withheld } = claudeAccountEnv(dir, options.parentEnv ?? process.env, options.allowEnv);
  const child = launchProvider(options.binary ?? 'claude', [...(options.binaryArgs ?? []), 'auth', 'status', '--json'], {
    ...options.processTree,
    cwd: options.cwd ?? process.cwd(),
    env,
  });
  const io = child.io ?? child.child;
  let bytes = '';
  let overflow = false;
  io.stdout?.setEncoding('utf8');
  io.stdout?.on('data', (chunk: string) => {
    if (overflow) return;
    if (bytes.length + chunk.length > MAX_STATUS_BYTES) { overflow = true; return; }
    bytes += chunk;
  });
  // Drained, never kept: stderr is not part of the answer.
  io.stderr?.resume();
  io.stdin?.end();
  const closed = child.closed ?? new Promise<void>((done) => { child.child.once('close', () => done()); });
  const deadline = options.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.started.then(() => closed),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ClaudeAccountError(`claude auth status did not answer within ${deadline} ms`)), deadline);
        timer.unref();
      }),
    ]);
  } catch (cause) {
    if (cause instanceof ClaudeAccountError) throw cause;
    throw new ClaudeAccountError('claude auth status could not be run');
  } finally {
    clearTimeout(timer);
    await child.stop({ graceMs: 0 }).catch(() => undefined);
  }
  if (overflow) throw new ClaudeAccountError('claude auth status exceeded its size bound');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes); } catch { throw new ClaudeAccountError('claude auth status did not print JSON'); }
  return claudeAccountStatusOf(parsed, dir, withheld);
}

/**
 * Parse a `claude auth status --json` object. Only named fields are kept, each cleaned and bounded, so a field the CLI
 * adds later -- whatever it holds -- never reaches the host through here.
 */
export function claudeAccountStatusOf(value: unknown, configDir: ClaudeConfigDir, withheld: readonly string[] = []): ClaudeAccountStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClaudeAccountError('claude auth status was not a JSON object');
  }
  const raw = value as Record<string, unknown>;
  const cliAuthMethod = field(raw.authMethod) ?? 'unknown';
  const apiKeySource = field(raw.apiKeySource);
  const method = methodOf(cliAuthMethod, apiKeySource);
  const signedIn = raw.loggedIn === true && method !== 'none';
  const reported = field(raw.configDirectory);
  const expected = configDir === null ? join(homedir(), '.claude') : resolve(configDir);
  const optional = (key: string, v: string | undefined) => (v === undefined ? {} : { [key]: v });
  return {
    signedIn,
    method,
    cliAuthMethod,
    requestedConfigDir: configDir === null ? null : resolve(configDir),
    billing: !signedIn ? 'none' : method === 'subscription' ? 'subscription' : method === 'console' || method === 'apiKey' ? 'apiUsage' : 'unknown',
    ...optional('email', field(raw.email)),
    ...optional('organizationId', field(raw.orgId)),
    ...optional('organizationName', field(raw.orgName)),
    ...optional('subscriptionType', field(raw.subscriptionType)),
    ...optional('apiKeySource', apiKeySource),
    ...optional('configDirectory', reported),
    // Older CLIs (before 2.1.268) do not report the directory; absence is not evidence of a mismatch.
    configDirectoryMatches: reported === undefined || samePath(reported, expected),
    loginExpiresAt: field(raw.loginExpiresAt) ?? null,
    withheld: Object.freeze([...withheld]),
  };
}

function methodOf(cliAuthMethod: string, apiKeySource: string | undefined): ClaudeAccountMethod {
  switch (cliAuthMethod) {
    case 'none': return 'none';
    case 'claude.ai': return 'subscription';
    case 'api_key_helper': return 'apiKey';
    // An environment variable's name is the source of an env key; anything else is a key Claude Code saved itself.
    case 'api_key': return apiKeySource !== undefined && /^[A-Z][A-Z0-9_]*$/.test(apiKeySource) ? 'apiKey' : 'console';
    default: return 'other';
  }
}

function field(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = boundProviderText(stripAnsiControlSequences(value).text, MAX_FIELD_CHARS).trim();
  return clean === '' ? undefined : clean;
}

function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase();
}

/** What a sign-in should produce: a claude.ai subscription (the default) or a Console login billed per token. */
export type ClaudeLoginMethod = 'subscription' | 'console';

export interface ClaudeLoginOptions {
  readonly method?: ClaudeLoginMethod;
  /** Pre-fills the email on Anthropic's sign-in page (`--email`). */
  readonly email?: string;
  readonly binary?: string;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  readonly allowEnv?: readonly string[];
}

export interface ClaudeLoginCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** The complete environment to start the visible terminal with: stripped, with CLAUDE_CONFIG_DIR chosen. */
  readonly env: Readonly<Record<string, string>>;
  /** What the command sets, for showing the person. */
  readonly set: Readonly<Record<string, string>>;
  /** What the command removes, for showing the person. */
  readonly unset: readonly string[];
  /** One line each, for a person who runs it by hand. */
  readonly display: { readonly posix: string; readonly powershell: string };
  /** Documented traps that apply to this choice. */
  readonly caveats: readonly string[];
}

/**
 * The command the HOST shows the person, in a terminal they can see, to sign in to that directory. The person
 * completes Anthropic's own flow in the browser; nothing here starts it, sees its result, or keeps anything it writes.
 */
export function claudeLoginCommand(configDir: ClaudeConfigDir, options: ClaudeLoginOptions = {}): ClaudeLoginCommand {
  const dir = claudeConfigDir(configDir);
  const method = options.method ?? 'subscription';
  if (method !== 'subscription' && method !== 'console') throw new ClaudeAccountError('method must be "subscription" or "console"');
  const email = options.email;
  if (email !== undefined && (typeof email !== 'string' || !/^[^\s@'"`$;&|<>()\\]+@[^\s@'"`$;&|<>()\\]+$/.test(email) || email.length > 254)) {
    throw new ClaudeAccountError('email must be a plain email address');
  }
  const binary = options.binary ?? 'claude';
  // eslint-disable-next-line no-control-regex
  if (typeof binary !== 'string' || binary.trim() === '' || /[\u0000-\u001f\u007f]/.test(binary)) throw new ClaudeAccountError('binary must be a command name or path');
  const args = ['auth', 'login', method === 'subscription' ? '--claudeai' : '--console', ...(email === undefined ? [] : ['--email', email])];
  const { env } = claudeAccountEnv(dir, options.parentEnv ?? process.env, options.allowEnv);
  const set: Record<string, string> = dir === null ? {} : { CLAUDE_CONFIG_DIR: dir };
  const unset = [...(dir === null ? ['CLAUDE_CONFIG_DIR'] : []), ...OUTRANKING_CREDENTIALS];
  const posix = [
    'env',
    ...unset.map((name) => `-u ${name}`),
    ...Object.entries(set).map(([name, value]) => `${name}=${posixQuote(value)}`),
    posixQuote(binary),
    ...args.map(posixQuote),
  ].join(' ');
  const powershell = [
    `Remove-Item ${unset.map((name) => `Env:${name}`).join(', ')} -ErrorAction SilentlyContinue`,
    ...Object.entries(set).map(([name, value]) => `$env:${name} = ${powershellQuote(value)}`),
    `& ${powershellQuote(binary)} ${args.map(powershellQuote).join(' ')}`,
  ].join('; ');
  const caveats: string[] = [];
  if (method === 'console') {
    caveats.push(
      'A Console sign-in without an API key is stored outside the configuration directory, so separate directories do not keep two of them apart (https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts).',
      'A Console sign-in without an API key signs out of any claude.ai login stored on the machine (https://code.claude.com/docs/en/authentication#sign-in-without-an-api-key).',
    );
  }
  if (dir === null) caveats.push('This signs in the CLI\'s default directory: the account a plain `claude` uses.');
  return Object.freeze({
    command: binary,
    args: Object.freeze(args),
    env: Object.freeze(env),
    set: Object.freeze(set),
    unset: Object.freeze(unset),
    display: Object.freeze({ posix, powershell }),
    caveats: Object.freeze(caveats),
  });
}

function posixQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:@=]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** The account the host selected: a directory and the method it expects there, plus what it remembered about it. */
export interface ClaudeAccountSelection {
  readonly configDir: ClaudeConfigDir;
  readonly method: ClaudeLoginMethod;
  /** The email the CLI reported when this account was set up, if the host kept it. */
  readonly email?: string;
}

/**
 * - `directory`: the status was taken for a different directory from the selected one (another path, or the default
 *   when a path was selected, or the reverse). The status describes another account.
 * - `configDirectory`: the CLI reported using a different directory from the one it was given.
 * - `method`, `email`: the account in that directory is not the one the person picked.
 */
export type ClaudeAccountDifference = 'directory' | 'method' | 'email' | 'configDirectory';

/**
 * Whether the live account is the selected one.
 *
 * `mismatch` is the state to show loudly: a launch now would use a different account or a different billing method
 * from the one the person picked. The documented ways that happens without anyone choosing it: an API key from a
 * settings file outranks the login; an expired subscription login falls back to another saved credential "billed to
 * its organization" (https://code.claude.com/docs/en/authentication#after-the-login-expires); a Console sign-in
 * replaced the claude.ai login.
 */
export type ClaudeAccountCheck =
  | { readonly state: 'ready'; readonly account: ClaudeAccountStatus }
  | { readonly state: 'signedOut'; readonly account: ClaudeAccountStatus }
  | {
    readonly state: 'mismatch';
    readonly account: ClaudeAccountStatus;
    readonly expected: ClaudeAccountSelection;
    readonly differences: readonly ClaudeAccountDifference[];
  };

/** Compare a status with a selection. Pure: no process, no filesystem. */
export function claudeAccountCheck(selection: ClaudeAccountSelection, account: ClaudeAccountStatus): ClaudeAccountCheck {
  const differences: ClaudeAccountDifference[] = [];
  if (!sameSelectedDirectory(selection.configDir, account)) differences.push('directory');
  if (!account.configDirectoryMatches) differences.push('configDirectory');
  if (!account.signedIn && differences.length === 0) return { state: 'signedOut', account };
  if (account.signedIn && account.method !== selection.method) differences.push('method');
  if (account.signedIn && selection.email !== undefined && account.email !== undefined
    && account.email.toLowerCase() !== selection.email.toLowerCase()) differences.push('email');
  // A subscription selection that now shows no email has lost its identity line: a different credential is in use.
  if (account.signedIn && selection.method === 'subscription' && selection.email !== undefined && account.email === undefined
    && !differences.includes('method')) differences.push('email');
  if (differences.length > 0) return { state: 'mismatch', account, expected: selection, differences: Object.freeze(differences) };
  return { state: 'ready', account };
}

/**
 * Whether the status describes the selected directory.
 *
 * `null` (the default) matches only a status taken with CLAUDE_CONFIG_DIR unset -- never one taken with the variable
 * set to the default's path, because Claude Code treats those two differently (see the top of this file). A path
 * matches a status taken for the same path: both resolved, so trailing separators and mixed separators do not count,
 * and case-insensitive where the filesystem usually is (Windows, macOS), as `samePath` does for the CLI's report.
 *
 * A status that does not say which directory it was taken for (built by hand, or stored by an older version of this
 * package) falls back to the directory the CLI reported, for a path; for the default there is nothing to compare
 * without assuming where the default lives, so it is a mismatch. An invalid selection is a mismatch, not a throw.
 */
function sameSelectedDirectory(selected: ClaudeConfigDir, account: ClaudeAccountStatus): boolean {
  let want: string | null;
  try { want = claudeConfigDir(selected); } catch { return false; }
  const asked = (account as { readonly requestedConfigDir?: ClaudeConfigDir }).requestedConfigDir;
  if (asked === undefined) return want !== null && account.configDirectory !== undefined && samePath(want, account.configDirectory);
  if (want === null || asked === null) return want === asked;
  return samePath(want, asked);
}

/** describe + compare, for a host about to launch. */
export async function checkClaudeAccount(selection: ClaudeAccountSelection, options: ClaudeAccountOptions = {}): Promise<ClaudeAccountCheck> {
  return claudeAccountCheck(selection, await describeClaudeAccount(selection.configDir, options));
}

/** The account-selection API in one place. */
export const claudeAccounts = Object.freeze({
  describe: describeClaudeAccount,
  loginCommand: claudeLoginCommand,
  check: checkClaudeAccount,
  compare: claudeAccountCheck,
  env: claudeAccountEnv,
});
