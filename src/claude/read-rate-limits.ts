/**
 * ONE CLAUDE ACCOUNT'S LIMIT WINDOWS, READ WITHOUT A TURN AND WITHOUT TOUCHING ITS CREDENTIAL (G-394, tynn #1084).
 *
 * The source is the CLI's own SDK control request `get_usage` with `skip_behaviors: true`. Measured on claude-code
 * 2.1.332 (2026-11-27), with nothing written but that one request (no `initialize`, no user message): an
 * unauthenticated directory answers `rate_limits_available: false` in under 0.4 s, and a signed-in Max account answers
 * its named windows plus `model_scoped[]` per-model caps (Fable) in under 1 s. The CLI describes the request as "the
 * structured /usage data ... Experimental -- the response shape may change", so the parser refuses a changed shape as
 * `malformed` instead of guessing. `skip_behaviors` is the CLI's own option "for callers that need only the plan rate
 * limits, such as a usage meter"; it skips a scan of seven days of local transcripts.
 *
 * What was NOT used, and why (design: the envelope's `.ai/plans/g394-claude-read-rate-limits.md`): a probe turn costs
 * the very limit being read; `-p "/usage"` is not documented for print mode and could not be shown to be turn-free;
 * a statusLine hook would mean writing into the account's settings and only fills after an interactive turn.
 *
 * The CLI runs with CLAUDE_CONFIG_DIR set to the chosen directory (or removed, for the default) and the
 * allow-list-first environment `claudeAccountEnv` builds, so every outranking credential is withheld and the CLI reads
 * its own login. Nothing here opens a file under the directory. Hooks, plugins, MCP servers and project settings are
 * kept out of the read (`--safe-mode`, `--strict-mcp-config`, `--setting-sources user`), and remote control is forced
 * off as on every launch (G-319).
 *
 * It never throws: anything it cannot read is a reading with `state` `unreadable` or `unsupported` and a `reasonCode`.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { NdjsonFramer, encodeLine } from '../ndjson.js';
import { launchProvider, type ProcessTreeOptions, type ProviderProcess } from '../process-tree.js';
import { assertNoRemoteControlArgs, claudeForcedSettingsJson } from '../remote-control.js';
import {
  claudeUsageRateLimitReading,
  unknownRateLimitReading,
  type RateLimitReading,
  type RateLimitUnknownReason,
} from '../rate-limit-reading.js';
import { claudeAccountEnv, claudeConfigDir, type ClaudeConfigDir } from './accounts.js';

export interface ReadClaudeRateLimitsOptions {
  /** The CLI to run. Default `claude`. */
  readonly binary?: string;
  readonly binaryArgs?: readonly string[];
  /** Working directory for the short-lived CLI. Default: the home directory. Project settings are not loaded either way. */
  readonly cwd?: string;
  /** Parent environment to build the child's from. Default `process.env`. Credential names are withheld (env.ts). */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Extra environment names to pass through. Credential names are refused here as everywhere. */
  readonly allowEnv?: readonly string[];
  readonly processTree?: ProcessTreeOptions;
  /** How long the whole read may take, 1 000 to 60 000 ms. Default 15 000. */
  readonly timeoutMs?: number;
  /**
   * How old a cached reading may be, in ms. Default 60 000; 0 always asks the CLI. A reading that knows nothing is
   * reused for at most 5 s, so a broken CLI is not respawned in a loop. `asOfMs` is when the CLI answered.
   */
  readonly maxAgeMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 60_000;
const MAX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_MAX_AGE_MS = 5_000;
/** The real answer is a few KiB. More than this before it arrives is refused. */
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;

interface CacheEntry {
  readonly value: Promise<RateLimitReading>;
  /** Set once the read settles: when, and for how long it may be reused. */
  settledAt?: number;
  ttlMs?: number;
}
const cache = new Map<string, CacheEntry>();

/** Forget every cached reading. For tests, and for a host that knows an account changed (a new sign-in). */
export function clearClaudeRateLimitCache(): void {
  cache.clear();
}

const unknown = (code: RateLimitUnknownReason, reason: string) => unknownRateLimitReading(code, reason, Date.now());

/**
 * The limit windows of the account signed in to `configDir` (`null`: the CLI's default account), as the one
 * {@link RateLimitReading} shape both drivers emit. Never throws and never rejects.
 */
export async function readClaudeRateLimits(configDir: ClaudeConfigDir, options: ReadClaudeRateLimitsOptions = {}): Promise<RateLimitReading> {
  // A JavaScript caller can pass anything; the promise still never rejects.
  if (typeof options !== 'object' || options === null) return unknown('invalid_options', 'claude_usage: options must be an object');
  try {
    return await readChecked(configDir, options);
  } catch {
    return unknown('cli_exited', 'claude_usage: the read failed');
  }
}

async function readChecked(configDir: ClaudeConfigDir, options: ReadClaudeRateLimitsOptions): Promise<RateLimitReading> {
  let dir: string | null;
  let timeoutMs: number;
  let maxAgeMs: number;
  let binaryArgs: string[];
  try {
    dir = claudeConfigDir(configDir);
    timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      return unknown('invalid_options', `claude_usage: timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
    }
    maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > MAX_MAX_AGE_MS) {
      return unknown('invalid_options', `claude_usage: maxAgeMs must be between 0 and ${MAX_MAX_AGE_MS}`);
    }
    if (options.binaryArgs !== undefined && (!Array.isArray(options.binaryArgs) || options.binaryArgs.some((arg) => typeof arg !== 'string'))) {
      return unknown('invalid_options', 'claude_usage: binaryArgs must be an array of strings');
    }
    binaryArgs = [...(options.binaryArgs ?? [])];
    // Host argv may not start remote control or put a second --settings ahead of the forced one (G-319).
    assertNoRemoteControlArgs('claude', binaryArgs);
  } catch {
    return unknown('invalid_options', 'claude_usage: configDir must be an absolute path or null, and binaryArgs may not carry remote control or --settings');
  }

  const binary = options.binary ?? 'claude';
  if (maxAgeMs === 0) return ask(binary, binaryArgs, dir, timeoutMs, options);

  const key = JSON.stringify([binary, binaryArgs, dir]);
  const hit = cache.get(key);
  if (hit !== undefined && (hit.settledAt === undefined || Date.now() - hit.settledAt <= Math.min(maxAgeMs, hit.ttlMs ?? maxAgeMs))) return hit.value;

  const entry: CacheEntry = { value: ask(binary, binaryArgs, dir, timeoutMs, options) };
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  void entry.value.then((reading) => {
    entry.settledAt = Date.now();
    entry.ttlMs = reading.state === 'reported' ? maxAgeMs : Math.min(maxAgeMs, UNKNOWN_MAX_AGE_MS);
  });
  return entry.value;
}

async function ask(binary: string, binaryArgs: readonly string[], dir: string | null, timeoutMs: number, options: ReadClaudeRateLimitsOptions): Promise<RateLimitReading> {
  let child: ProviderProcess;
  try {
    const { env } = claudeAccountEnv(dir, options.parentEnv ?? process.env, options.allowEnv);
    const args = [
      ...binaryArgs,
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--settings', claudeForcedSettingsJson(),
      '--safe-mode', '--setting-sources', 'user', '--strict-mcp-config', '--no-session-persistence',
    ];
    child = launchProvider(binary, args, { ...options.processTree, cwd: options.cwd ?? homedir(), env });
  } catch {
    return unknown('cli_unavailable', 'claude_usage: the Claude CLI could not be started');
  }

  const io = child.io ?? child.child;
  const id = `prism-acp-usage-${randomBytes(6).toString('hex')}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<RateLimitReading>((resolve) => {
      let settled = false;
      const finish = (reading: RateLimitReading) => { if (!settled) { settled = true; resolve(reading); } };
      timer = setTimeout(() => finish(unknown('timeout', `claude_usage: the Claude CLI did not answer within ${timeoutMs} ms`)), timeoutMs);
      timer.unref();

      const framer = new NdjsonFramer();
      let bytes = 0;
      io.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (bytes > MAX_STDOUT_BYTES) { finish(unknown('too_large', `claude_usage: more than ${MAX_STDOUT_BYTES} bytes arrived before the answer`)); return; }
        for (const frame of framer.push(chunk)) {
          if (!frame.ok || typeof frame.value !== 'object' || frame.value === null) continue;
          const value = frame.value as Record<string, unknown>;
          if (value.type !== 'control_response' || typeof value.response !== 'object' || value.response === null) continue;
          const response = value.response as Record<string, unknown>;
          if (response.request_id !== id) continue;
          // The CLI's error text is not quoted: it is provider text, and the code says enough.
          finish(response.subtype === 'success'
            ? claudeUsageRateLimitReading(response.response, Date.now())
            : unknown('refused', 'claude_usage: the Claude CLI refused the get_usage request'));
          return;
        }
      });
      // Drained, never kept: stderr is not part of the answer.
      io.stderr?.resume();
      const exited = () => finish(unknown('cli_exited', 'claude_usage: the Claude CLI exited before answering'));
      if (child.closed !== undefined) void child.closed.then(exited, exited);
      else child.child.once('close', exited);
      child.started.then(() => {
        if (settled) return;
        // The ONLY line written: no initialize and no user message, so no turn can start.
        io.stdin?.write(encodeLine({ type: 'control_request', request_id: id, request: { subtype: 'get_usage', skip_behaviors: true } }));
      }, () => finish(unknown('cli_unavailable', 'claude_usage: the Claude CLI could not be started')));
    });
  } catch {
    return unknown('cli_exited', 'claude_usage: the read failed');
  } finally {
    clearTimeout(timer);
    try { io.stdin?.end(); } catch { /* already closed */ }
    await child.stop({ graceMs: 0 }).catch(() => undefined);
  }
}
