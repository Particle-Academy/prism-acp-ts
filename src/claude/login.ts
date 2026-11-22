/**
 * SIGNING IN AND OUT FROM AN APP, WITH NO TERMINAL (Wish, 2026-11-22: "I should not see any terminals nor do we store
 * login keys"; the Genie use case confirmed by tynn).
 *
 * The CLI's OWN flow runs, unchanged: `claude auth login` (or `logout`) with the account's CLAUDE_CONFIG_DIR, in a
 * hidden child under the package's process-tree supervisor. This module hands the host one thing -- the sign-in URL,
 * after checking it is an `https://` URL on an Anthropic or Claude host -- and the person completes Anthropic's flow
 * in their own browser. The CLI receives the result and writes its own credentials into its own directory. Nothing
 * here opens, reads, copies, stores or logs a file under that directory, a credential, or the CLI's output beyond the
 * URL and its prompts; a pasted code, when the flow needs one, goes from the host straight to the CLI's stdin.
 *
 * Measured against claude-code 2.1.330 on Windows, 2026-11-21, with no sign-in completed (each run killed, its
 * throwaway directory deleted; no `.credentials.json` was ever left):
 *
 * - With no TTY the CLI still runs the whole flow. It prints `Opening browser to sign in…`, then
 *   `If the browser didn't open, visit:` and a URL, then `Paste code here if prompted > `, and waits.
 * - It also starts its own browser: the URL goes to `$BROWSER` when set, else (Windows) `rundll32 url,OpenURL`.
 * - There are TWO URLs. The one handed to the browser opener carries `redirect_uri=http://localhost:<port>/callback`
 *   (the CLI listens on 127.0.0.1 for it), so the browser returns the sign-in to the CLI by itself. The PRINTED one is
 *   the manual fallback: for `--console` it carries `redirect_uri=https://platform.claude.com/oauth/code/callback`, a
 *   page that SHOWS a code to paste; for `--claudeai` it is an opaque `https://claude.ai/oauth/authorize?...` link.
 * - A code written to stdin is read without a TTY: a bogus one was submitted and refused (`Couldn't log in: That code
 *   wasn't accepted...`, exit 1).
 * - `claude auth logout` prints `Successfully logged out from your Anthropic account.` and exits 0, even in a
 *   directory that was never signed in.
 *
 * So this sets `BROWSER` to a one-shot helper of its own, in a private temporary directory, which hands the opener's
 * URL back through a file there instead of opening anything. The host gets the localhost-redirect URL and no code is
 * needed. If the helper never fires (a settings file can name another browser), the printed URL is used and the host
 * is asked for the code; the same happens if the CLI says the browser could not return the sign-in.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { restrictToCurrentUser } from '../private-directory.js';
import { launchProvider, type ProcessTreeOptions, type ProviderProcess } from '../process-tree.js';
import { assertNoRemoteControlArgs } from '../remote-control.js';
import { stripAnsiControlSequences } from '../text.js';
import { ClaudeAccountError } from './account-error.js';
import { claudeAccountEnv, claudeConfigDir, describeClaudeAccount, type ClaudeAccountStatus, type ClaudeConfigDir, type ClaudeLoginMethod } from './accounts.js';

/** The hosts a sign-in URL may point at. Exact names: no suffix match, so `claude.ai.example` is refused. */
export const CLAUDE_SIGN_IN_HOSTS: readonly string[] = Object.freeze([
  'claude.ai',
  'claude.com',
  'platform.claude.com',
  'console.anthropic.com',
]);

/**
 * Why a sign-in or sign-out did not finish.
 *
 * - `aborted`: the host's signal fired. `timeout`: the deadline passed. Either way the tree was killed.
 * - `refusedUrl`: the CLI offered a URL that is not `https://` on {@link CLAUDE_SIGN_IN_HOSTS}. It was never handed out.
 * - `noUrl`: the CLI ended before offering a URL.
 * - `codeRequired`: the flow needs a pasted code and the host gave no `onCodeRequested`.
 * - `invalidCode`: `onCodeRequested` returned something that is not one line of printable text.
 * - `failed`: the CLI exited non-zero (a refused code, a network failure). Its text is not passed on.
 * - `refusedDirectory`: `configDir` was null or the CLI's default directory; these calls are for ADDED accounts.
 * - `missingDirectory`: sign-out of a directory that does not exist.
 */
export type ClaudeLoginFailure =
  | 'aborted' | 'timeout' | 'refusedUrl' | 'noUrl' | 'codeRequired' | 'invalidCode' | 'failed'
  | 'refusedDirectory' | 'missingDirectory';

export class ClaudeLoginError extends ClaudeAccountError {
  override readonly name: string = 'ClaudeLoginError';
  readonly code: ClaudeLoginFailure;
  constructor(code: ClaudeLoginFailure, message: string) {
    super(message);
    this.code = code;
  }
}

interface ClaudeAuthRunOptions {
  readonly signal?: AbortSignal;
  /** Default 600 000 (10 minutes) for sign-in, 60 000 for sign-out. 1 .. 3 600 000. */
  readonly timeoutMs?: number;
  /** The CLI to run. Default `claude`. */
  readonly binary?: string;
  readonly binaryArgs?: readonly string[];
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  readonly allowEnv?: readonly string[];
  readonly processTree?: ProcessTreeOptions;
}

export interface ClaudeSignInOptions extends ClaudeAuthRunOptions {
  /** `subscription` (claude.ai, the default) or `console` (API usage billing). */
  readonly method?: ClaudeLoginMethod;
  /** Pre-fills the email on Anthropic's sign-in page (`--email`). */
  readonly email?: string;
  /** Receives the sign-in URL, once. Open it in the person's browser. Only a checked `https://` URL arrives here. */
  onUrl(url: string): void | Promise<void>;
  /**
   * Called when the flow needs the code Anthropic's page shows. Return the code the person pasted; it is written to the
   * CLI's stdin and nowhere else. `signal` fires when the sign-in ends some other way -- dismiss the paste box then.
   */
  onCodeRequested?(signal: AbortSignal): Promise<string>;
}

export type ClaudeSignOutOptions = ClaudeAuthRunOptions;

const LOGIN_TIMEOUT_MS = 600_000;
const LOGOUT_TIMEOUT_MS = 60_000;
const MAX_URL_CHARS = 8192;
const MAX_CODE_CHARS = 4096;
const MAX_OUTPUT_CHARS = 64 * 1024;
/** How long the printed URL waits for the opener's URL before the manual fallback is used. */
const OPENER_GRACE_MS = 3_000;
const MANUAL_FALLBACK_TEXT = "can't return the sign-in to Claude Code automatically";

/**
 * Check a sign-in URL: `https:`, an exact host from {@link CLAUDE_SIGN_IN_HOSTS}, no user info, the default port, no
 * whitespace or control characters, bounded. Returns the URL unchanged, or null.
 */
export function claudeSignInUrl(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_URL_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(candidate)) return null;
  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (!CLAUDE_SIGN_IN_HOSTS.includes(url.hostname)) return null;
  return candidate;
}

/** The directory for an added account: absolute, and never the default (null or `~/.claude`). */
function accountDirectory(configDir: ClaudeConfigDir): string {
  const dir = claudeConfigDir(configDir);
  if (dir === null || samePath(dir, join(homedir(), '.claude'))) {
    throw new ClaudeLoginError('refusedDirectory', 'sign-in and sign-out here are for added accounts: configDir must be a path other than the CLI default');
  }
  return dir;
}

function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase();
}

function deadlineOf(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isInteger(ms) || ms < 1 || ms > 3_600_000) throw new ClaudeAccountError('timeoutMs must be an integer from 1 to 3600000');
  return ms;
}

function checkBinary(binary: string): string {
  // eslint-disable-next-line no-control-regex
  if (typeof binary !== 'string' || binary.trim() === '' || /[\u0000-\u001f\u007f]/.test(binary)) throw new ClaudeAccountError('binary must be a command name or path');
  return binary;
}

/**
 * What was in the account directory before this call: whether it existed, and the NAMES of its top-level entries.
 * Metadata only; no file is opened.
 */
interface DirectoryBefore {
  readonly existed: boolean;
  readonly entries: ReadonlySet<string>;
}

function snapshotDirectory(dir: string): DirectoryBefore {
  let info;
  try { info = lstatSync(dir); } catch { return { existed: false, entries: new Set() }; }
  if (!info.isDirectory()) throw new ClaudeAccountError('configDir exists and is not a directory');
  return { existed: true, entries: new Set(readdirSync(dir)) };
}

/** Create the account directory itself (never its parents), private to this user. */
function createPrivateDirectory(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (cause) {
    if ((cause as { code?: unknown }).code === 'ENOENT') throw new ClaudeAccountError('configDir\'s parent does not exist; only the directory itself is created');
    throw new ClaudeAccountError('configDir could not be created');
  }
  try { restrictToCurrentUser(dir); } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new ClaudeAccountError('configDir could not be made private to this user');
  }
}

/**
 * Undo a half-made sign-in: a directory this call created goes entirely; in one that already existed, only the
 * top-level entries that were not there before go. Nothing that was there before is touched, and nothing is read.
 * `rmSync` removes a link itself, never what it points at.
 */
function cleanHalfMade(dir: string, before: DirectoryBefore): void {
  if (!before.existed) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return;
  }
  let now: string[];
  try { now = readdirSync(dir); } catch { return; }
  for (const name of now) {
    if (before.entries.has(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * A private temporary directory holding the `BROWSER` stand-in. The CLI runs it with the opener URL as its one
 * argument; it writes that URL to `url` beside itself (via a rename, so a half-written file is never read) and opens
 * nothing. On Windows the CLI starts a `.cmd` through cmd.exe, which runs this runtime as Node on a script; elsewhere
 * it is a POSIX shell script.
 */
interface OpenerHelper {
  readonly dir: string;
  readonly browser: string;
  /** The URL the opener received, once; null until then. The file is deleted when read. */
  take(): string | null;
  remove(): void;
}

function createOpenerHelper(): OpenerHelper {
  const dir = mkdtempSync(join(tmpdir(), 'prism-acp-login-'));
  try {
    restrictToCurrentUser(dir);
    let browser: string;
    if (process.platform === 'win32') {
      writeFileSync(join(dir, 'opener.mjs'), [
        "import { writeFileSync, renameSync } from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        "const here = (name) => fileURLToPath(new URL(name, import.meta.url));",
        `const url = String(process.argv[2] ?? '').slice(0, ${MAX_URL_CHARS + 1});`,
        "writeFileSync(here('url.tmp'), url, { mode: 0o600 });",
        "renameSync(here('url.tmp'), here('url'));",
        '',
      ].join('\n'));
      browser = join(dir, 'opener.cmd');
      const electron = process.versions.electron !== undefined ? '@set "ELECTRON_RUN_AS_NODE=1"\r\n' : '';
      // %~dp0 is this script's own directory, so no host path is spelled into a cmd.exe line beyond the runtime's.
      writeFileSync(browser, `@echo off\r\n${electron}"${process.execPath}" "%~dp0opener.mjs" %1\r\n`);
    } else {
      browser = join(dir, 'opener.sh');
      const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
      writeFileSync(browser, `#!/bin/sh\numask 077\nprintf '%s' "$1" > ${quoted}/url.tmp && mv -f ${quoted}/url.tmp ${quoted}/url\n`, { mode: 0o700 });
      chmodSync(browser, 0o700);
    }
    return {
      dir,
      browser,
      take() {
        const file = join(dir, 'url');
        if (!existsSync(file)) return null;
        try {
          if (statSync(file).size > MAX_URL_CHARS + 1) { rmSync(file, { force: true }); return ''; }
          const url = readFileSync(file, 'utf8');
          rmSync(file, { force: true });
          return url;
        } catch { return null; }
      },
      remove() { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    };
  } catch (cause) {
    rmSync(dir, { recursive: true, force: true });
    throw cause;
  }
}

/** Run one `claude auth ...` under the supervisor and settle on exit, abort or timeout, always killing the tree. */
class AuthRun {
  readonly child: ProviderProcess;
  readonly done: Promise<number | null>;
  #output = '';
  #onOutput: (() => void) | null = null;
  #exitCode: number | null = null;
  #exited = false;

  constructor(binary: string, args: readonly string[], cwd: string, env: Record<string, string>, processTree: ProcessTreeOptions | undefined) {
    this.child = launchProvider(binary, args, { ...processTree, cwd, env });
    const io = this.child.io ?? this.child.child;
    const take = (chunk: string) => {
      if (this.#output.length < MAX_OUTPUT_CHARS) this.#output += chunk.slice(0, MAX_OUTPUT_CHARS - this.#output.length);
      this.#onOutput?.();
    };
    io.stdout?.setEncoding('utf8');
    io.stdout?.on('data', take);
    // stderr is read for the CLI's prompts only (some builds print them there); it is never passed on or kept past this call.
    io.stderr?.setEncoding('utf8');
    io.stderr?.on('data', take);
    this.child.child.once('exit', (code) => { this.#exitCode = code; });
    const closed = this.child.closed ?? new Promise<void>((done) => { this.child.child.once('close', () => done()); });
    this.done = this.child.started.then(() => closed).then(() => { this.#exited = true; this.#onOutput?.(); return this.#exitCode; });
    this.done.catch(() => {});
  }

  get output(): string { return stripAnsiControlSequences(this.#output).text; }
  get exited(): boolean { return this.#exited; }
  set onOutput(fn: (() => void) | null) { this.#onOutput = fn; }

  write(text: string): void {
    const io = this.child.io ?? this.child.child;
    io.stdin?.write(text);
  }

  async kill(): Promise<void> {
    await this.child.stop({ graceMs: 0 }).catch(() => undefined);
  }
}

/** Settles when the run exits, the signal fires or the deadline passes. */
function guard(signal: AbortSignal | undefined, deadline: number, what: string): { promise: Promise<never>; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (signal?.aborted) { reject(new ClaudeLoginError('aborted', `${what} was cancelled`)); return; }
    onAbort = () => reject(new ClaudeLoginError('aborted', `${what} was cancelled`));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new ClaudeLoginError('timeout', `${what} did not finish within ${deadline} ms`)), deadline);
    timer.unref();
  });
  promise.catch(() => {});
  return {
    promise,
    dispose() {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    },
  };
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;

/**
 * Sign an added account in, through the CLI's own flow, with no terminal. Resolves with `describe()`'s answer once the
 * CLI has finished; rejects with a {@link ClaudeLoginError} otherwise, having killed the CLI's whole process tree and
 * removed only what this call added to the directory.
 */
export async function signInClaudeAccount(configDir: string, options: ClaudeSignInOptions): Promise<ClaudeAccountStatus> {
  const dir = accountDirectory(configDir);
  if (typeof options?.onUrl !== 'function') throw new ClaudeAccountError('onUrl is required');
  const method = options.method ?? 'subscription';
  if (method !== 'subscription' && method !== 'console') throw new ClaudeAccountError('method must be "subscription" or "console"');
  const email = options.email;
  if (email !== undefined && (typeof email !== 'string' || !/^[^\s@'"`$;&|<>()\\%!^]+@[^\s@'"`$;&|<>()\\%!^]+$/.test(email) || email.length > 254)) {
    throw new ClaudeAccountError('email must be a plain email address');
  }
  assertNoRemoteControlArgs('claude', options.binaryArgs);
  const binary = checkBinary(options.binary ?? 'claude');
  const deadline = deadlineOf(options.timeoutMs, LOGIN_TIMEOUT_MS);
  if (options.signal?.aborted) throw new ClaudeLoginError('aborted', 'sign-in was cancelled');

  const before = snapshotDirectory(dir);
  if (!before.existed) createPrivateDirectory(dir);
  let helper: OpenerHelper | undefined;
  let run: AuthRun | undefined;
  const ended = new AbortController();
  const stop = guard(options.signal, deadline, 'sign-in');
  let succeeded = false;
  try {
    helper = createOpenerHelper();
    const { env } = claudeAccountEnv(dir, options.parentEnv ?? process.env, options.allowEnv);
    env.BROWSER = helper.browser;
    const args = [...(options.binaryArgs ?? []), 'auth', 'login', method === 'subscription' ? '--claudeai' : '--console', ...(email === undefined ? [] : ['--email', email])];
    run = new AuthRun(binary, args, helper.dir, env, options.processTree);
    const flow = drive(run, helper, options, ended.signal);
    const code = await Promise.race([flow, stop.promise]);
    if (code !== 0) throw new ClaudeLoginError('failed', 'the CLI did not complete the sign-in');
    const status = await describeClaudeAccount(dir, {
      binary, ...(options.binaryArgs === undefined ? {} : { binaryArgs: options.binaryArgs }),
      cwd: helper.dir, ...(options.parentEnv === undefined ? {} : { parentEnv: options.parentEnv }),
      ...(options.allowEnv === undefined ? {} : { allowEnv: options.allowEnv }),
      ...(options.processTree === undefined ? {} : { processTree: options.processTree }),
    });
    succeeded = status.signedIn;
    return status;
  } finally {
    stop.dispose();
    ended.abort();
    if (run !== undefined) await run.kill();
    helper?.remove();
    if (!succeeded) cleanHalfMade(dir, before);
  }
}

/** Hand out the URL, answer a code request, and resolve with the CLI's exit code. */
async function drive(run: AuthRun, helper: OpenerHelper, options: ClaudeSignInOptions, ended: AbortSignal): Promise<number | null> {
  let urlSent = false;
  let manual = false;
  let printedAt = 0;
  let codeAsked = false;
  return await new Promise<number | null>((resolveExit, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; clearInterval(poll); reject(error); } };
    const askCode = () => {
      if (codeAsked) return;
      codeAsked = true;
      if (typeof options.onCodeRequested !== 'function') {
        fail(new ClaudeLoginError('codeRequired', 'the sign-in needs the code shown on Anthropic\'s page, and no onCodeRequested was given'));
        return;
      }
      Promise.resolve().then(() => options.onCodeRequested!(ended)).then((code) => {
        if (settled || ended.aborted) return;
        // eslint-disable-next-line no-control-regex
        if (typeof code !== 'string' || code.trim() === '' || code.length > MAX_CODE_CHARS || /[\u0000-\u001f\u007f-\u009f]/.test(code.trim())) {
          fail(new ClaudeLoginError('invalidCode', 'the code must be one line of printable text'));
          return;
        }
        run.write(`${code.trim()}\n`);
      }, () => { if (!settled && !ended.aborted) fail(new ClaudeLoginError('aborted', 'the code request was cancelled')); });
    };
    const send = (url: string) => {
      const checked = claudeSignInUrl(url);
      if (checked === null) { fail(new ClaudeLoginError('refusedUrl', 'the CLI offered a sign-in URL that is not https on an Anthropic or Claude host; it was not handed out')); return; }
      urlSent = true;
      Promise.resolve().then(() => options.onUrl(checked)).catch(() => fail(new ClaudeLoginError('failed', 'onUrl threw; the sign-in was stopped')));
      if (manual) askCode();
    };
    const step = () => {
      if (settled) return;
      if (!urlSent) {
        const opened = helper.take();
        if (opened !== null) { send(opened); if (settled) return; }
      }
      const text = run.output;
      if (!urlSent) {
        const printed = text.match(URL_PATTERN)?.[0];
        if (printed !== undefined) {
          // A non-Anthropic URL is refused on sight, whichever channel it came through.
          if (claudeSignInUrl(printed) === null) { send(printed); return; }
          if (printedAt === 0) printedAt = Date.now();
          if (Date.now() - printedAt >= OPENER_GRACE_MS) { manual = true; send(printed); if (settled) return; }
        }
      }
      if (urlSent && text.includes(MANUAL_FALLBACK_TEXT)) askCode();
      if (run.exited) {
        settled = true;
        clearInterval(poll);
        run.done.then((code) => {
          if (!urlSent && code !== 0) { reject(new ClaudeLoginError('noUrl', 'the CLI ended before offering a sign-in URL')); return; }
          resolveExit(code);
        }, reject);
      }
    };
    const poll = setInterval(step, 100);
    // The call ended another way (abort, timeout): stop watching, so nothing of this flow outlives it.
    ended.addEventListener('abort', () => { if (!settled) { settled = true; clearInterval(poll); } }, { once: true });
    run.onOutput = step;
    run.done.then(step, (cause) => fail(cause instanceof Error ? new ClaudeLoginError('failed', 'the CLI could not be started') : cause));
  });
}

/**
 * Sign an added account out, through the CLI's own `claude auth logout` in that directory, with no terminal. Resolves
 * with `describe()`'s answer afterwards. The directory itself is left in place.
 */
export async function signOutClaudeAccount(configDir: string, options: ClaudeSignOutOptions = {}): Promise<ClaudeAccountStatus> {
  const dir = accountDirectory(configDir);
  assertNoRemoteControlArgs('claude', options.binaryArgs);
  const binary = checkBinary(options.binary ?? 'claude');
  const deadline = deadlineOf(options.timeoutMs, LOGOUT_TIMEOUT_MS);
  if (options.signal?.aborted) throw new ClaudeLoginError('aborted', 'sign-out was cancelled');
  let isDir = false;
  try { isDir = lstatSync(dir).isDirectory(); } catch { /* missing */ }
  if (!isDir) throw new ClaudeLoginError('missingDirectory', 'configDir does not exist; there is nothing to sign out of');
  const work = mkdtempSync(join(tmpdir(), 'prism-acp-logout-'));
  const stop = guard(options.signal, deadline, 'sign-out');
  let run: AuthRun | undefined;
  try {
    const { env } = claudeAccountEnv(dir, options.parentEnv ?? process.env, options.allowEnv);
    run = new AuthRun(binary, [...(options.binaryArgs ?? []), 'auth', 'logout'], work, env, options.processTree);
    (run.child.io ?? run.child.child).stdin?.end();
    const code = await Promise.race([run.done, stop.promise]);
    if (code !== 0) throw new ClaudeLoginError('failed', 'the CLI did not complete the sign-out');
    return await describeClaudeAccount(dir, {
      binary, ...(options.binaryArgs === undefined ? {} : { binaryArgs: options.binaryArgs }),
      cwd: work, ...(options.parentEnv === undefined ? {} : { parentEnv: options.parentEnv }),
      ...(options.allowEnv === undefined ? {} : { allowEnv: options.allowEnv }),
      ...(options.processTree === undefined ? {} : { processTree: options.processTree }),
    });
  } finally {
    stop.dispose();
    if (run !== undefined) await run.kill();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

