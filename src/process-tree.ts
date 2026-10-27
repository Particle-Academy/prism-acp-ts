import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { launchWindowsLocal } from './process-tree-local.js';
import { SUPERVISOR_CS } from './process-tree-supervisor-cs.js';

/**
 * A PROVIDER'S WHOLE PROCESS TREE ENDS WITH IT (tynn, Genie, 2026-10-20). On Windows the provider used to be spawned
 * through `cmd.exe /d /s /c`, and killing it was TerminateProcess on cmd.exe alone: claude.exe or codex and everything
 * they had started -- MCP servers, shells, tool subprocesses -- survived a Stop, a Restart ran two providers on one
 * conversation, and a crash of the host left all of them running, on both operating systems.
 *
 * Every provider now runs under a SUPERVISOR, a small process that owns the tree:
 *
 *  - Windows: the supervisor (C#, built once per install from {@link SUPERVISOR_CS} and hash-checked before every launch) creates the provider SUSPENDED,
 *    assigns it to a Job Object with KILL_ON_JOB_CLOSE and no breakaway, and only then resumes it, so nothing the
 *    provider starts can escape the job, `detached` children included. Only the supervisor holds the job handle, and
 *    the supervisor sits in libuv's own kill-on-close job, so the host's death ends the supervisor and with it the tree.
 *  - Elsewhere: the supervisor (Node, {@link SUPERVISOR_JS}) starts the provider as the leader of its own process group
 *    and kills that group on stop, on the provider's own exit, and when the host's control socket closes. On Linux it
 *    also kills every descendant it can find through /proc -- by parent chain, and by a random per-launch cookie in
 *    the environment (`PRISM_ACP_TREE_ID`, as Jenkins' ProcessTreeKiller does with BUILD_ID) -- which catches a child
 *    that called setsid, even one orphaned before the stop. Every pid is checked against its start time before it is
 *    signalled, so a reused pid is never touched. NOT caught on Linux: a descendant that clears its environment AND
 *    leaves the group AND is orphaned; only a cgroup would hold that. Elsewhere (macOS): only the process group.
 *
 * The provider is spawned directly, never through a shell: on Windows a `.cmd` is accepted only as an npm shim, and
 * run as node + its script. The current directory is never searched for the binary, unlike cmd.exe, so a workspace
 * cannot plant one.
 *
 * Control protocol, one line each way over a private named pipe or Unix socket authenticated by a random token:
 *   -> hello <token>        <- spawn <spec>        -> started <pid> | failed <code>
 *   <- kill                 -> exited <code>       -> empty <processes left>
 * The control channel closing is a kill.
 */

/** How the tree is held. */
export type Containment =
  | { readonly kind: 'job-object' }
  | { readonly kind: 'process-group'; readonly pgid: number };

/** The provider's process, and what holds its tree. Record these to find the tree from outside. */
export interface ProcessTree {
  readonly providerPid: number;
  readonly supervisorPid: number;
  readonly containment: Containment;
}

/** What `stop()` found. */
export interface StopVerdict {
  /** The provider exited on its own, before the tree was terminated. */
  readonly graceful: boolean;
  /**
   * No process of the tree is left. On Windows that is the job's own count, which nothing in the tree can leave. On
   * Linux it covers the provider's process group and every descendant found by parent chain or by the cookie (see
   * above); on other POSIX systems, the process group only.
   */
  readonly empty: boolean;
  /** Processes the supervisor still counted after terminating the tree; null when it could not count. */
  readonly survivors: number | null;
  /**
   * The supervisor confirmed the count itself. False when it ended without reporting (it was killed): on Windows the
   * kernel still ends the job with it, so `empty` is true but was not observed.
   */
  readonly verified: boolean;
}

export interface StopOptions {
  /** How long the provider gets to exit on its own once its stdin is closed. Default 5000. */
  readonly graceMs?: number;
}

/** A provider under supervision. Use `io ?? child` for provider bytes; `child` is always the real supervisor. */
export interface ProviderProcess {
  readonly child: ChildProcess;
  /** Provider byte streams for transports that do not use ChildProcess stdio. */
  readonly io?: ProviderIo;
  /** Supervisor has ended and provider output has drained (bounded to five seconds). */
  readonly closed?: Promise<void>;
  /** Resolves once the provider runs inside its tree; rejects if it could not be started. */
  readonly started: Promise<ProcessTree>;
  /** Null until started. */
  readonly tree: ProcessTree | null;
  /** Close stdin, wait the grace, terminate the tree, and resolve once nothing of it is left (or the wait gives up). */
  stop(options?: StopOptions): Promise<StopVerdict>;
  /** Terminate the whole tree now. */
  kill(signal?: NodeJS.Signals): void;
}

export interface ProviderIo {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export interface ProcessTreeOptions {
  /** Pending stdio writes/output backpressure deadline in LOCAL mode, 1..60000 ms. Default 30000; idle sessions are allowed. */
  readonly ioTimeoutMs?: number;
  /** Opt into AppContainer-compatible LOCAL pipes. No loopback/network permission is required. Windows only. */
  readonly windowsStdio?: 'local-pipes';
  /** Deadline for the local-pipe supervisor/provider startup; default 10000 ms, maximum 60000 ms. */
  readonly startupTimeoutMs?: number;
}

export interface LaunchOptions extends ProcessTreeOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Refused before anything ran. The message names no path. */
export class ProcessTreeError extends Error {
  override readonly name = 'ProcessTreeError';
}

const CHANNEL_ENV = 'PRISM_ACP_TREE_CHANNEL';
const TOKEN_ENV = 'PRISM_ACP_TREE_TOKEN';
const SUPERVISOR_REPORT_MS = 10_000;

/** Start `command args` under a supervisor that owns its whole process tree. */
export function launchProvider(command: string, args: readonly string[], options: LaunchOptions): ProviderProcess {
  const windows = process.platform === 'win32';
  if (options.windowsStdio !== undefined && (options.windowsStdio !== 'local-pipes' || !windows)) {
    throw new ProcessTreeError('local-pipe stdio requires Windows');
  }
  const startupTimeout = options.startupTimeoutMs ?? 10_000;
  if (!Number.isInteger(startupTimeout) || startupTimeout < 1 || startupTimeout > 60_000) {
    throw new ProcessTreeError('startupTimeoutMs must be an integer from 1 to 60000');
  }
  if (options.startupTimeoutMs !== undefined && options.windowsStdio !== 'local-pipes') {
    throw new ProcessTreeError('startupTimeoutMs requires local-pipe stdio');
  }
  if (options.ioTimeoutMs !== undefined && (options.windowsStdio !== 'local-pipes' || !Number.isInteger(options.ioTimeoutMs) || options.ioTimeoutMs < 1 || options.ioTimeoutMs > 60_000)) {
    throw new ProcessTreeError('ioTimeoutMs requires local-pipe stdio and an integer from 1 to 60000');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
  const spec = windows ? windowsSpawnSpec(command, args, options.cwd, env) : posixSpawnSpec(command, args, options.cwd);
  const supervisor = windows ? windowsSupervisor() : null;
  if (options.windowsStdio === 'local-pipes') return launchWindowsLocal(supervisor!, spec, options, startupTimeout);

  const token = randomBytes(32).toString('hex');
  const socketDirectory = windows ? null : mkdtempSync(join(tmpdir(), 'prism-acp-tree-'));
  const channel = windows ? `\\\\.\\pipe\\prism-acp-tree-${randomBytes(12).toString('hex')}` : join(socketDirectory!, 'tree.sock');
  const control = new ControlChannel(token, spec);
  control.listen(channel, () => {
    if (socketDirectory !== null) rmSync(socketDirectory, { recursive: true, force: true });
  });

  const electron = !windows && process.versions.electron !== undefined;
  const supervisorEnv = { ...env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), [CHANNEL_ENV]: channel, [TOKEN_ENV]: token };
  // The POSIX supervisor uses this runtime as Node, even inside an Electron app. Restore the provider's original
  // environment before SUPERVISOR_JS spawns it: the injected flag must never change how a provider/helper starts.
  const restoreElectron = env.ELECTRON_RUN_AS_NODE === undefined
    ? 'delete process.env.ELECTRON_RUN_AS_NODE;\n'
    : `process.env.ELECTRON_RUN_AS_NODE = ${JSON.stringify(env.ELECTRON_RUN_AS_NODE)};\n`;
  let child: ChildProcess;
  try {
    child = supervisor !== null
      ? spawn(supervisor, [], { cwd: options.cwd, env: supervisorEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(process.execPath, ['-e', (electron ? `'use strict';\n${restoreElectron}` : '') + SUPERVISOR_JS], { cwd: options.cwd, env: supervisorEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (cause) {
    control.close();
    if (socketDirectory !== null) rmSync(socketDirectory, { recursive: true, force: true });
    throw cause;
  }
  return new SupervisedProvider(child, control, windows);
}

class SupervisedProvider implements ProviderProcess {
  readonly child: ChildProcess;
  readonly started: Promise<ProcessTree>;
  readonly #control: ControlChannel;
  readonly #windows: boolean;
  #tree: ProcessTree | null = null;
  #exited = false;
  #verdict: Promise<StopVerdict> | null = null;
  #supervisorGone: Promise<void>;

  constructor(child: ChildProcess, control: ControlChannel, windows: boolean) {
    this.child = child;
    this.#control = control;
    this.#windows = windows;
    this.#supervisorGone = new Promise((resolve) => child.once('close', () => resolve()));
    let spawnErrored = false;
    child.once('error', () => { spawnErrored = true; });
    this.started = new Promise<ProcessTree>((resolve, reject) => {
      control.onStarted = (pid) => {
        this.#tree = {
          providerPid: pid,
          supervisorPid: child.pid ?? 0,
          containment: windows ? { kind: 'job-object' } : { kind: 'process-group', pgid: pid },
        };
        resolve(this.#tree);
      };
      const fail = (code: string) => {
        const error = new ProcessTreeError(`failed to start the provider (${code})`);
        reject(error);
        // The drivers report a spawn failure from the child's 'error' event, as they always have.
        // A supervisor that itself failed to spawn has already said so there.
        if (!spawnErrored && child.listenerCount('error') > 0) child.emit('error', error);
      };
      control.onFailed = fail;
      child.once('close', () => { if (this.#tree === null) fail('supervisor ended before the provider started'); });
    });
    // Nobody may be awaiting it; a rejection here is reported through 'error'.
    this.started.catch(() => {});
    control.onExited = () => { this.#exited = true; };
    child.once('close', () => control.close());
  }

  get tree(): ProcessTree | null {
    return this.#tree;
  }

  stop(options: StopOptions = {}): Promise<StopVerdict> {
    this.#verdict ??= this.#stop(options.graceMs ?? 5_000);
    return this.#verdict;
  }

  kill(): void {
    // A tree kill, whatever the signal: the point of supervision is that nothing outlives the provider.
    if (!this.#control.send('kill')) this.child.kill();
  }

  async #stop(graceMs: number): Promise<StopVerdict> {
    const emptied = this.#control.emptied;
    this.child.stdin?.end();
    const graceful = this.#exited || await Promise.race([
      this.#control.exitedPromise.then(() => true),
      this.#supervisorGone.then(() => false),
      delay(graceMs).then(() => false),
    ]);
    if (!this.#exited) this.kill();
    const reported = await Promise.race([
      emptied,
      this.#supervisorGone.then(() => this.#control.emptyCount),
      delay(SUPERVISOR_REPORT_MS).then(() => null),
    ]);
    if (reported === null) {
      // The supervisor did not answer: end it. On Windows that closes the job, and the kernel ends the tree.
      this.child.kill();
      await Promise.race([this.#supervisorGone, delay(SUPERVISOR_REPORT_MS)]);
    } else {
      // The supervisor exits right after its report. Waiting for it means that when stop() resolves nothing of ours
      // is running: the supervisor's working directory is the provider's, and a host may remove it next.
      await Promise.race([this.#supervisorGone, delay(SUPERVISOR_REPORT_MS)]);
    }
    if (typeof reported === 'number') return { graceful, empty: reported === 0, survivors: reported, verified: true };
    return { graceful, empty: this.#windows, survivors: null, verified: false };
  }
}

/** The supervisor's end of the protocol, in the host. */
class ControlChannel {
  onStarted: (pid: number) => void = () => {};
  onFailed: (code: string) => void = () => {};
  onExited: () => void = () => {};
  emptyCount: number | null = null;
  readonly emptied: Promise<number>;
  readonly exitedPromise: Promise<void>;
  readonly #token: string;
  readonly #spec: string;
  #server: Server | null = null;
  #socket: Socket | null = null;
  #resolveEmpty!: (count: number) => void;
  #resolveExited!: () => void;

  constructor(token: string, spec: string) {
    this.#token = token;
    this.#spec = spec;
    this.emptied = new Promise((resolve) => { this.#resolveEmpty = resolve; });
    this.exitedPromise = new Promise((resolve) => { this.#resolveExited = resolve; });
  }

  listen(path: string, onAuthenticated: () => void): void {
    const server = createServer((socket) => {
      if (this.#socket !== null) { socket.destroy(); return; }
      socket.setEncoding('utf8');
      let buffer = '';
      let authenticated = false;
      // A connection that does not authenticate promptly is dropped, so none can be held open for nothing.
      const deadline = setTimeout(() => { if (!authenticated) socket.destroy(); }, 10_000);
      deadline.unref();
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 4096) { socket.destroy(); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!authenticated) {
            // The first line must be the token, or the connection is dropped and the channel stays open for the
            // real supervisor.
            const presented = Buffer.from(line);
            const expected = Buffer.from(`hello ${this.#token}`);
            if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) { socket.destroy(); return; }
            authenticated = true;
            clearTimeout(deadline);
            this.#socket = socket;
            this.#server?.close();
            this.#server = null;
            onAuthenticated();
            socket.write(`${this.#spec}\n`);
            continue;
          }
          this.#onLine(line);
        }
      });
      socket.on('error', () => {});
    });
    server.listen(path);
    this.#server = server;
  }

  send(line: string): boolean {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) return false;
    socket.write(`${line}\n`);
    return true;
  }

  close(): void {
    this.#server?.close();
    this.#server = null;
    this.#socket?.destroy();
  }

  #onLine(line: string): void {
    const [word, value] = line.split(' ');
    if (word === 'started' && value !== undefined && /^\d+$/.test(value)) this.onStarted(Number(value));
    else if (word === 'failed') this.onFailed(/^[\w-]{1,40}$/.test(value ?? '') ? value! : 'unknown');
    else if (word === 'exited') { this.onExited(); this.#resolveExited(); }
    else if (word === 'empty' && value !== undefined && /^\d+$/.test(value)) {
      this.emptyCount = Number(value);
      this.#resolveEmpty(this.emptyCount);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

function posixSpawnSpec(command: string, args: readonly string[], cwd: string): string {
  return ['spawn', b64(command), b64(cwd), ...args.map(b64)].join(' ');
}

function windowsSpawnSpec(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): string {
  const resolved = resolveWindowsCommand(command, env);
  const commandLine = windowsCommandLine([resolved.application, ...resolved.args, ...args]);
  return ['spawn', b64(resolved.application), b64(commandLine), b64(cwd)].join(' ');
}

/**
 * One Windows command line from an argv, quoted so the C runtime and CommandLineToArgvW read back exactly that argv
 * (backslashes are literal except before a quote). Never interpreted by a shell, so `&`, `|` and `%` are plain text.
 */
export function windowsCommandLine(argv: readonly string[]): string {
  return argv.map((arg) => {
    if (arg !== '' && !/[\s"]/.test(arg)) return arg;
    let quoted = '"';
    let backslashes = 0;
    for (const ch of arg) {
      if (ch === '\\') { backslashes += 1; continue; }
      if (ch === '"') quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      else quoted += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
    return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
  }).join(' ');
}

const NPM_SHIM = /"%_prog%"\s+"%dp0%\\([^"%\r\n]+)"\s+%\*\s*$/m;

/**
 * What to run for `command` on Windows, without a shell: an `.exe` or `.com` as itself, an npm `.cmd` shim as node +
 * its script. Searches PATH with PATHEXT the way CreateProcess callers do, but NOT the current directory.
 */
export function resolveWindowsCommand(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): { readonly application: string; readonly args: readonly string[] } {
  const lookup = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
  const extensions = (lookup('pathext') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const hasPath = /[\\/:]/.test(command);
  if (hasPath && !isAbsolute(command)) throw new ProcessTreeError('a provider binary given as a path must be absolute');
  const directories = hasPath ? [''] : (lookup('path') ?? '').split(delimiter)
    .map((d) => d.replace(/^"(.*)"$/, '$1')).filter((d) => d !== '' && isAbsolute(d));
  const ownExtension = extname(command).toLowerCase();
  const names = ownExtension !== '' && extensions.includes(ownExtension) ? [command] : extensions.map((e) => command + e);

  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory === '' ? name : join(directory, name);
      if (!isFile(candidate)) continue;
      const extension = extname(candidate).toLowerCase();
      if (extension === '.exe' || extension === '.com') return { application: candidate, args: [] };
      if (extension === '.cmd' || extension === '.bat') return npmShim(candidate, env);
      throw new ProcessTreeError(`the provider resolves to a ${extension} file, which cannot be run without a shell`);
    }
  }
  throw new ProcessTreeError('the provider binary was not found on PATH');
}

function npmShim(shim: string, env: Readonly<Record<string, string | undefined>>): { application: string; args: string[] } {
  const text = statSync(shim).size <= 65_536 ? readFileSync(shim, 'utf8') : '';
  const match = NPM_SHIM.exec(text);
  if (match === null) {
    // Running it would need cmd.exe, which interprets its arguments. Refused rather than run uncontained or unquoted.
    throw new ProcessTreeError('the provider is a batch file that is not an npm shim; give the path of its .exe instead');
  }
  const script = join(dirname(shim), match[1]!);
  if (!isFile(script)) throw new ProcessTreeError('the npm shim names a script that does not exist');
  const local = join(dirname(shim), 'node.exe');
  if (isFile(local)) return { application: local, args: [script] };
  const node = resolveWindowsCommand('node.exe', env).application;
  return { application: node, args: [script] };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

let supervisorDirectoryOverride: string | null = null;

/** Where the supervisor is built: once per install, keyed by its source, so a new release builds its own. */
function supervisorDirectory(): string {
  if (supervisorDirectoryOverride !== null) return supervisorDirectoryOverride;
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  const version = createHash('sha256').update(SUPERVISOR_CS).digest('hex').slice(0, 16);
  return join(base, 'prism-acp', `supervisor-${version}`);
}

const sha256Of = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Read one atomic pointer, then verify the immutable executable named by that digest. */
function verifiedSupervisor(directory: string): { state: 'ok'; executable: string } | { state: 'missing' | 'mismatch' } {
  const pointer = join(directory, 'prism-acp-supervisor.current.sha256');
  if (!isFile(pointer)) return { state: 'missing' };
  try {
    if (statSync(pointer).size > 80) return { state: 'mismatch' };
    const hash = readFileSync(pointer, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) return { state: 'mismatch' };
    const executable = join(directory, `prism-acp-supervisor-${hash}.exe`);
    if (!isFile(executable)) return { state: 'missing' };
    return sha256Of(executable) === hash ? { state: 'ok', executable } : { state: 'mismatch' };
  } catch {
    return { state: 'missing' };
  }
}

/**
 * The supervisor executable: built once per install with the csc.exe of .NET Framework 4 (Framework64, FrameworkArm64
 * or Framework, whichever exists), its SHA-256 recorded at build, and verified before EVERY launch. A mismatch rebuilds
 * once, then refuses. Every failure is a ProcessTreeError that names its cause; an uncontained provider is never
 * offered as a fallback.
 */
function windowsSupervisor(): string {
  const directory = supervisorDirectory();
  const state = verifiedSupervisor(directory);
  if (state.state === 'ok') return state.executable;

  const windowsDirectory = process.env.SystemRoot ?? process.env.windir ?? 'C:\Windows';
  const csc = ['Framework64', 'FrameworkArm64', 'Framework']
    .map((bits) => join(windowsDirectory, 'Microsoft.NET', bits, 'v4.0.30319', 'csc.exe'))
    .find(isFile);
  if (csc === undefined) {
    throw new ProcessTreeError('cannot contain the provider: the .NET Framework 4 compiler (csc.exe) was not found');
  }
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    throw new ProcessTreeError('cannot contain the provider: the supervisor directory could not be created');
  }
  const unique = randomBytes(6).toString('hex');
  const source = join(directory, `supervisor-${unique}.cs`);
  const built = join(directory, `prism-acp-supervisor-${unique}.exe`);
  const pointer = join(directory, 'prism-acp-supervisor.current.sha256');
  const pendingPointer = join(directory, `supervisor-${unique}.sha256`);
  try {
    writeFileSync(source, SUPERVISOR_CS);
    execFileSync(csc, ['-nologo', '-optimize+', '-target:exe', `-out:${built}`, source], { stdio: 'ignore', windowsHide: true });
  } catch {
    rmSync(built, { force: true });
    throw new ProcessTreeError('cannot contain the provider: the supervisor failed to compile');
  } finally {
    rmSync(source, { force: true });
  }
  if (!isFile(built)) {
    throw new ProcessTreeError('cannot contain the provider: the supervisor was removed right after it was built (antivirus quarantine is the likely cause)');
  }
  const hash = sha256Of(built);
  const executable = join(directory, `prism-acp-supervisor-${hash}.exe`);
  try {
    // Compilers can produce different bytes concurrently. Never replace an executable another reader may launch:
    // publish immutable bytes first, then atomically replace only the small pointer to that complete generation.
    try { linkSync(built, executable); }
    catch { if (!isFile(executable) || sha256Of(executable) !== hash) throw new Error('supervisor publication failed'); }
    if (sha256Of(executable) !== hash) throw new Error('supervisor publication hash mismatch');
    writeFileSync(pendingPointer, hash, { flag: 'wx' });
    renameSync(pendingPointer, pointer);
  } catch {
    // A competing publisher may have won. Only its independently verified complete generation is accepted below.
  } finally {
    rmSync(built, { force: true });
    rmSync(pendingPointer, { force: true });
  }
  const after = verifiedSupervisor(directory);
  if (after.state === 'ok') return after.executable;
  throw new ProcessTreeError(after.state === 'mismatch'
    ? 'cannot contain the provider: the supervisor does not match the hash recorded when it was built, and could not be replaced'
    : 'cannot contain the provider: the supervisor is missing after it was built (antivirus quarantine is the likely cause)');
}

/** Prepare the hash-verified native approval adapter BEFORE Claude starts. No interpreter/unguarded fallback. */
export function windowsApprovalAdapter(): string {
  if (process.platform !== 'win32') throw new ProcessTreeError('the Claude native approval adapter requires Windows');
  try { return windowsSupervisor(); }
  catch (cause) {
    throw new ProcessTreeError(`cannot prepare Claude approval adapter: ${cause instanceof ProcessTreeError ? cause.message : 'native adapter verification failed'}`);
  }
}

/** Internal private-file support: quiet native operation, no global libuv pipes or NUL. */
export function createWindowsPrivateDirectory(directory: string): void {
  if (process.platform !== 'win32') throw new ProcessTreeError('Windows private directory protection is unavailable');
  if (!isAbsolute(directory)) throw new ProcessTreeError('private directory must be absolute');
  try {
    execFileSync(windowsSupervisor(), ['--create-private-directory', directory], {
      stdio: 'inherit', windowsHide: true, timeout: 5_000,
    });
  } catch (cause) {
    const status = (cause as { status?: unknown }).status;
    throw new ProcessTreeError(`failed to protect the private directory for this Windows identity${Number.isInteger(status) ? ` (exit ${String(status)})` : ''}`);
  }
}

/**
 * Build (or verify) the Windows supervisor ahead of the first session, so a missing compiler or a quarantined
 * executable surfaces once, at startup, as a ProcessTreeError. A no-op elsewhere. `directory` overrides where it is
 * kept (default: %LOCALAPPDATA%/prism-acp/supervisor-<source hash>); set it before the first launch.
 */
export async function prepareProcessTree(options: { readonly directory?: string } = {}): Promise<void> {
  if (options.directory !== undefined) {
    if (!isAbsolute(options.directory)) throw new ProcessTreeError('the supervisor directory must be absolute');
    supervisorDirectoryOverride = options.directory;
  }
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  windowsSupervisor();
}

/**
 * The POSIX supervisor, run as `node -e`. See the protocol above. It is outside the provider's process group, so it
 * survives the group kill to report on it.
 */
export const SUPERVISOR_JS = String.raw`'use strict';
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const channel = process.env.PRISM_ACP_TREE_CHANNEL;
const token = process.env.PRISM_ACP_TREE_TOKEN;
delete process.env.PRISM_ACP_TREE_CHANNEL;
delete process.env.PRISM_ACP_TREE_TOKEN;
if (!channel || !token) process.exit(125);
let child = null;
let finished = false;
let exit = null;
// pid -> start time (Linux, /proc/<pid>/stat field 22) of every process seen in the tree. A start time is what makes a
// pid safe to signal later: a pid that was reused since belongs to someone else, and is never touched.
const known = new Map();
const socket = net.connect(channel);
const say = (line) => { try { socket.write(line + '\n'); } catch (e) {} };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Linux only (elsewhere: an empty map, and only the process group is held).
function scan() {
  const procs = new Map();
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch (e) { return procs; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.set(Number(name), { ppid: Number(fields[1]), pgrp: Number(fields[2]), start: fields[19] });
    } catch (e) {}
  }
  return procs;
}
const same = (procs, pid) => procs.has(pid) && procs.get(pid).start === known.get(pid);
// The tree's cookie, inherited by every descendant that does not clear its environment (as Jenkins' ProcessTreeKiller
// does with BUILD_ID): it finds a child that called setsid and was then orphaned, which no parent chain reaches.
const cookie = Buffer.from('PRISM_ACP_TREE_ID=' + require('crypto').randomBytes(16).toString('hex') + '\0');
function carriesCookie(pid) {
  try {
    const environ = fs.readFileSync('/proc/' + pid + '/environ');
    return environ.indexOf(cookie) === 0 || environ.indexOf(Buffer.concat([Buffer.from([0]), cookie])) !== -1;
  } catch (e) { return false; }
}
// Record the tree: the provider's group, every process carrying the cookie, everything whose parent chain reaches
// either, and everything descended from a process already recorded.
function track(procs) {
  const pgid = child.pid;
  for (const [pid, info] of procs) {
    if (!known.has(pid) && pid !== process.pid && (info.pgrp === pgid || carriesCookie(pid))) known.set(pid, info.start);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, info] of procs) {
      if (known.has(pid) && !same(procs, pid)) continue;
      if (!known.has(pid) && (info.ppid === pgid || same(procs, info.ppid))) { known.set(pid, info.start); grew = true; }
    }
  }
}
function signalAll(procs, signal) {
  // The group only while a member still holds its id: an empty group's id is a free pid, and could be someone else's.
  const groupHeld = procs.size === 0 || [...procs.values()].some((info) => info.pgrp === child.pid);
  if (groupHeld) { try { process.kill(-child.pid, signal); } catch (e) {} }
  for (const pid of known.keys()) if (same(procs, pid)) { try { process.kill(pid, signal); } catch (e) {} }
}
function finish() {
  if (finished || child === null || !child.pid) { if (child === null) process.exit(1); return; }
  finished = true;
  const pgid = child.pid;
  // Freeze, collect until nothing new appears, then kill: a frozen process cannot start another.
  for (let round = 0; round < 5; round++) {
    const before = known.size;
    const procs = scan();
    track(procs);
    signalAll(procs, 'SIGSTOP');
    if (known.size === before && round > 0) break;
  }
  signalAll(scan(), 'SIGKILL');
  const started = Date.now();
  const left = () => {
    const procs = scan();
    let n = groupAlive(pgid) ? 1 : 0;
    for (const pid of known.keys()) if (pid !== pgid && same(procs, pid) && procs.get(pid).pgrp !== pgid) n++;
    return n;
  };
  const poll = () => {
    const n = left();
    if (n > 0 && Date.now() - started < 5000) { setTimeout(poll, 20); return; }
    say('empty ' + n);
    socket.end(() => {
      if (exit && exit.signal) { process.removeAllListeners(exit.signal); process.kill(process.pid, exit.signal); }
      process.exit(exit && typeof exit.code === 'number' ? exit.code : 1);
    });
    setTimeout(() => process.exit(1), 1000).unref();
  };
  poll();
}
socket.setEncoding('utf8');
socket.on('connect', () => say('hello ' + token));
socket.on('error', () => {});
socket.on('close', () => finish());
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const parts = line.split(' ');
    if (parts[0] === 'spawn' && child === null && parts.length >= 3) {
      const decode = (s) => Buffer.from(s, 'base64').toString('utf8');
      try {
        const env = Object.assign({}, process.env, { PRISM_ACP_TREE_ID: cookie.toString().slice('PRISM_ACP_TREE_ID='.length, -1) });
        child = spawn(decode(parts[1]), parts.slice(3).map(decode), { cwd: decode(parts[2]), env, stdio: 'inherit', detached: true });
      } catch (e) { say('failed ' + (e.code || 'spawn')); process.exit(127); }
      child.on('error', (e) => { say('failed ' + (e.code || 'spawn')); socket.end(() => process.exit(127)); });
      child.on('spawn', () => say('started ' + child.pid));
      child.on('exit', (code, signal) => { exit = { code, signal }; say('exited ' + (code === null ? signal : code)); finish(); });
    } else if (line === 'kill') finish();
  }
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => finish());
`;
