import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { restrictToCurrentUser } from './private-directory.js';
import type { ProcessTreeOptions } from './process-tree.js';

/**
 * HOW A DRIVEN CLI AUTHENTICATES: the person's own subscription login, or an API key the app supplies.
 *
 * A deployment uses one or the other, and an app may offer its users or tenants either. So this is app or tenant
 * configuration, handed to the driver (and to listModels) by the embedder -- never something a client sends over ACP.
 *
 * ## Subscription (the default)
 *
 * The CLI uses its own stored login, and every inherited credential that would OUTRANK that login is withheld from it
 * (see env.ts): an inherited key otherwise bills per token while the session looks like a subscription one, or fails
 * 401 without falling back.
 *
 * ## API key
 *
 * The key is given to the CLI explicitly, and the CLI runs with `home` as its configuration home -- CLAUDE_CONFIG_DIR
 * for Claude, CODEX_HOME for Codex -- a directory the app owns, per app or per tenant. That is what keeps the person's
 * own login untouched, and it was measured, not assumed (claude-code 2.1.308, codex-cli 0.163.0, 2026-10-23, with a
 * deliberately invalid key so nothing was spent):
 *
 * - Claude, `-p` with ANTHROPIC_API_KEY and its own CLAUDE_CONFIG_DIR, used the key at once -- no prompt, no fallback
 *   (`401 Invalid API key`) -- wrote its state only into that directory, and left `~/.claude` untouched.
 * - Codex's app-server, logged in with `account/login/start { type: 'apiKey' }` under its own CODEX_HOME, reported
 *   `authMode: apikey` and left `~/.codex/auth.json` untouched.
 *
 * Under the person's OWN home the second would replace their ChatGPT login with the key, so a home that IS a
 * subscription home is refused. Everything else about `home` is the app's choice; a directory this creates is
 * restricted to the current user, because Codex keeps the key in it (auth.json, in plain text).
 *
 * What a home does not share with the person's: their settings, MCP servers, skills and session history. A session
 * started under one home resumes under that home only.
 */
export type ProviderCredentials =
  | { readonly mode: 'subscription' }
  | {
    readonly mode: 'apiKey';
    /** The provider API key: Anthropic's for Claude, OpenAI's for Codex. Never logged, never put in argv. */
    readonly apiKey: string;
    /** The CLI's configuration home for this app or tenant: an absolute path, not the person's own. */
    readonly home: string;
  };

/** Where a provider keeps its subscription login, and the variable that moves it. */
const PROVIDER_HOMES = {
  claude: { variable: 'CLAUDE_CONFIG_DIR', defaultDirectory: '.claude' },
  codex: { variable: 'CODEX_HOME', defaultDirectory: '.codex' },
} as const;

export type CredentialProvider = keyof typeof PROVIDER_HOMES;

/** An API-key configuration, checked: the key's shape and the home, which is created if it does not exist. */
export interface ApiKeyHome {
  readonly apiKey: string;
  /** The home, resolved to an absolute path. */
  readonly home: string;
}

/**
 * Check API-key credentials and make sure their home exists. Null for subscription credentials (or none). Throws
 * when the key is empty or malformed, or the home is relative or is a subscription home: the message names the
 * field, never the key.
 */
export function apiKeyHome(
  provider: CredentialProvider,
  credentials: ProviderCredentials | undefined,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
  processTree?: ProcessTreeOptions,
): ApiKeyHome | null {
  if (credentials === undefined || credentials.mode === 'subscription') return null;
  if (credentials.mode !== 'apiKey') throw new Error('credentials.mode must be "subscription" or "apiKey"');
  const { apiKey, home } = credentials;
  // eslint-disable-next-line no-control-regex
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new Error('credentials.apiKey must be a non-empty key with no control characters');
  }
  if (typeof home !== 'string' || !isAbsolute(home)) {
    throw new Error('credentials.home must be an absolute path');
  }
  const resolved = resolve(home);
  for (const subscriptionHome of subscriptionHomes(provider, parentEnv)) {
    if (samePath(resolved, subscriptionHome)) {
      throw new Error(`credentials.home is this user's own ${provider} configuration home: an API key there would replace or mix with their subscription login`);
    }
  }
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) throw new Error('credentials.home exists and is not a directory');
  } else {
    // AppContainer provisioning belongs to the host. The ordinary ACL helper
    // invokes OS tools with libuv stdio pairs, which cannot run in this mode.
    if (processTree?.windowsStdio === 'local-pipes') throw new Error('credentials.home must already exist when using LOCAL transport');
    try {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
      try {
        restrictToCurrentUser(resolved);
      } catch (cause) {
        // Left in place, the next start would find it existing and accept it as the app's own home, unrestricted.
        rmSync(resolved, { recursive: true, force: true });
        throw cause;
      }
    } catch {
      throw new Error('credentials.home could not be created as a private directory');
    }
  }
  return { apiKey, home: resolved };
}

/**
 * The environment entries that put a CLI in API-key mode: its home, and (for Claude) the key. Codex takes its key
 * through `account/login/start` instead, so for Codex only the home is here.
 */
export function apiKeyEnvironment(provider: CredentialProvider, checked: ApiKeyHome): Record<string, string> {
  return provider === 'claude'
    ? { CLAUDE_CONFIG_DIR: checked.home, ANTHROPIC_API_KEY: checked.apiKey }
    : { CODEX_HOME: checked.home };
}

/** The homes a provider's subscription login can live in: its default, and wherever the parent environment moved it. */
function subscriptionHomes(provider: CredentialProvider, parentEnv: Readonly<Record<string, string | undefined>>): string[] {
  const { variable, defaultDirectory } = PROVIDER_HOMES[provider];
  const homes = [join(homedir(), defaultDirectory)];
  const name = Object.keys(parentEnv).find((name) => name.toUpperCase() === variable);
  const moved = name === undefined ? undefined : parentEnv[name]?.trim();
  if (moved !== undefined && moved !== '' && isAbsolute(moved)) homes.push(moved);
  return homes.map((path) => resolve(path));
}

/** The same directory: through symlinks where they exist, and without case on Windows and macOS. */
function samePath(a: string, b: string): boolean {
  const real = (path: string) => { try { return realpathSync.native(path); } catch { return path; } };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase();
}
