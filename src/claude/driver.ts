/**
 * Spawn the Claude CLI and turn its `stream-json` output into ACP updates.
 *
 * This is the piece that joins the others: {@link childEnv} builds the
 * environment, {@link NdjsonFramer} splits the output, {@link ClaudeToAcp}
 * translates it. Each of those is tested on its own, so what is left here is
 * process handling -- which is the part that cannot be unit-tested, and
 * therefore the part worth keeping small.
 *
 * The argv and the stdin encoding are exported as pure functions for exactly
 * that reason. A driver whose flags could only be checked by spawning something
 * would have its most mistake-prone surface covered by its least reliable test.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { childEnv } from '../env.js';
import { NdjsonFramer, encodeLine } from '../ndjson.js';
import { type AcpUpdate, ClaudeToAcp } from './to-acp.js';

/** ACP permission modes map onto the CLI's own `--permission-mode` values. */
export type ClaudePermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan';

export interface ClaudeDriverOptions {
  /** Working directory for the agent. */
  readonly cwd: string;
  /** Binary to run. Overridable for tests and unusual installs. */
  readonly binary?: string;
  /** Parent environment to build the child's from. Defaults to `process.env`. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Extra environment names to pass through to the child. */
  readonly allowEnv?: readonly string[];
  /** Resume an existing CLI session instead of starting a new one. */
  readonly resumeSessionId?: string;
  readonly permissionMode?: ClaudePermissionMode;
  /** Tool names the agent may use. Omitted means the CLI's own default. */
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

export interface ClaudeDriverEvents {
  /** One ACP `session/update` payload. */
  readonly onUpdate?: (update: AcpUpdate) => void;
  /**
   * A line the CLI wrote to stderr.
   *
   * Surfaced rather than discarded, because the most valuable diagnostic this
   * CLI produces arrives here and nowhere else:
   *
   *   > claude.ai connectors are disabled because ANTHROPIC_API_KEY or another
   *   > auth source is set and takes precedence over your claude.ai login
   *
   * A driver that dropped stderr would turn the clearest possible explanation
   * of a billing or auth problem into silence followed by a 401.
   */
  readonly onStderr?: (line: string) => void;
  /** A frame that arrived but could not be framed or parsed. */
  readonly onProtocolError?: (problem: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /**
   * One turn finished.
   *
   * Separate from onExit because with `--input-format stream-json` the CLI
   * stays alive ACROSS turns -- the process exiting and a turn ending are
   * different events, and a server that conflated them would resolve every
   * prompt only when the agent shut down.
   */
  readonly onTurnEnd?: (outcome: TurnOutcome) => void;
}

/**
 * Build the CLI arguments.
 *
 * Every flag here is load-bearing and was verified against the binary rather
 * than recalled:
 *
 * - `--print` with `--output-format stream-json` and `--input-format
 *   stream-json` gives a bidirectional structured stream, which is what makes
 *   this possible without a third-party adapter.
 * - `--verbose` is REQUIRED for `stream-json` output; without it the CLI
 *   refuses the combination.
 * - `--include-partial-messages` is what produces the deltas that become
 *   `agent_message_chunk` and `agent_thought_chunk`. Without it the reply
 *   arrives in one lump and the whole point of a streaming transport is lost.
 */
export function claudeArgs(options: ClaudeDriverOptions): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (options.resumeSessionId !== undefined) args.push('--resume', options.resumeSessionId);
  if (options.permissionMode !== undefined) args.push('--permission-mode', options.permissionMode);
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push('--allowed-tools', options.allowedTools.join(','));
  }
  if (options.disallowedTools !== undefined && options.disallowedTools.length > 0) {
    args.push('--disallowed-tools', options.disallowedTools.join(','));
  }

  return args;
}

/**
 * Encode one user turn for `--input-format stream-json`.
 *
 * The CLI expects the same message envelope it emits, not a bare string.
 */
export function promptLine(text: string): string {
  return encodeLine({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

/** ACP's five stop reasons. No sixth, and no "unknown". */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface TurnOutcome {
  /** Null when the turn did not finish cleanly -- see {@link turnOutcomeOf}. */
  readonly stopReason: StopReason | null;
  readonly isError: boolean;
  /** The CLI's own reason string, kept even when it maps to nothing. */
  readonly raw: string | null;
}

/**
 * ACP stop reasons the CLI reports under the same names.
 *
 * Shared vocabulary for the common cases, which is luck rather than design, so
 * it is written as a map instead of passed through. A pass-through would import
 * every future CLI value into a closed ACP enum silently.
 */
const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turn_requests: 'max_turn_requests',
  refusal: 'refusal',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

/**
 * Read a turn's outcome from a `result` frame, or null if it is not one.
 *
 * `stopReason` comes back **null** when the CLI reported an error or a reason
 * ACP has no literal for. That is deliberate and it is the whole reason this
 * returns a structure rather than a string: ACP's five reasons all describe a
 * turn that FINISHED, and none of them describes a crash. Answering `end_turn`
 * for a failed turn would report a clean finish, and `refusal` would report a
 * decision the agent never made. A caller that cannot name the stop reason
 * should fail the request instead of inventing one.
 */
export function turnOutcomeOf(frame: unknown): TurnOutcome | null {
  if (!isObject(frame) || frame.type !== 'result') return null;

  const raw = typeof frame.stop_reason === 'string' ? frame.stop_reason : null;
  const isError = frame.is_error === true || frame.subtype === 'error';
  const mapped = raw === null ? undefined : STOP_REASONS[raw];

  return { stopReason: isError || mapped === undefined ? null : mapped, isError, raw };
}

/**
 * The CLI's own session id, from its `init` frame.
 *
 * Needed for `--resume`, which is how ACP's `session/load` is served. Captured
 * from the stream rather than invented, because the two ids are not the same
 * thing: ACP's sessionId is ours to choose, the CLI's is the CLI's.
 */
export function cliSessionIdOf(frame: unknown): string | null {
  if (!isObject(frame) || frame.type !== 'system' || frame.subtype !== 'init') return null;
  return typeof frame.session_id === 'string' ? frame.session_id : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn framed output into ACP updates, separating what mapped from what failed
 * to frame.
 *
 * Extracted from the driver so the wiring has a test that does not require
 * spawning anything. The framer and the mapper are each covered thoroughly on
 * their own, but "the framer's output reaches the mapper and both kinds of
 * result reach the caller" is its own claim, and the only other place it could
 * be checked is an opt-in live test that does not run in CI.
 */
export function updatesFromFrames(
  frames: readonly ReturnType<NdjsonFramer['push']>[number][],
  mapper: ClaudeToAcp,
): { updates: AcpUpdate[]; problems: string[] } {
  const updates: AcpUpdate[] = [];
  const problems: string[] = [];

  for (const frame of frames) {
    if (!frame.ok) {
      problems.push(frame.error.message);
      continue;
    }
    updates.push(...mapper.frame(frame.value));
  }

  return { updates, problems };
}

export class ClaudeDriver {
  readonly #options: ClaudeDriverOptions;
  readonly #events: ClaudeDriverEvents;
  readonly #framer = new NdjsonFramer();
  readonly #mapper = new ClaudeToAcp();
  #child: ChildProcess | null = null;
  #stderr = '';
  #pendingOutcome: TurnOutcome | null = null;

  /** Names of credentials withheld from the child, available after start(). */
  withheldCredentials: readonly string[] = [];

  /**
   * The CLI's own session id, once it has announced one.
   *
   * Not the same thing as an ACP sessionId: that one is ours to choose, this
   * one is the CLI's, and `--resume` wants the CLI's. Conflating them is how a
   * resume silently starts a fresh conversation.
   */
  cliSessionId: string | null = null;

  constructor(options: ClaudeDriverOptions, events: ClaudeDriverEvents = {}) {
    this.#options = options;
    this.#events = events;
  }

  /** Frames the mapper could not place. */
  get unmapped(): readonly unknown[] {
    return this.#mapper.unmapped;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  start(): void {
    if (this.#child !== null) throw new Error('driver already started');

    const { env, withheld } = childEnv(this.#options.parentEnv ?? process.env, {
      allow: [
        // The CLI finds the user's own login through these, so they are allowed
        // explicitly rather than inherited wholesale.
        'CLAUDE_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        ...(this.#options.allowEnv ?? []),
      ],
    });
    this.withheldCredentials = withheld;

    const child = spawn(this.#options.binary ?? 'claude', claudeArgs(this.#options), {
      cwd: this.#options.cwd,
      env,
      // On Windows the binary is a `.cmd` shim, which cannot be executed
      // directly. The shim re-entering whatever `node` is on PATH is a real
      // hazard for a JS entry point; for the CLI itself the shim IS the
      // documented entry, so the shell is the right way to reach it.
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.#onStderr(chunk));

    child.on('error', (cause: Error) => {
      // A spawn failure (ENOENT for a missing binary) arrives here and nowhere
      // else. Reported as a protocol error so a caller cannot mistake "the CLI
      // is not installed" for "the agent said nothing".
      this.#events.onProtocolError?.(`failed to spawn: ${cause.message}`);
    });

    child.on('close', (code, signal) => {
      // Flush first: a frame can be complete without its trailing newline, and
      // the LAST frame of a turn is the `result` that carries the outcome.
      this.#emit(this.#framer.end());
      this.#events.onExit?.(code, signal);
    });
  }

  /** Send a user turn. */
  prompt(text: string): void {
    const stdin = this.#child?.stdin;
    if (stdin === null || stdin === undefined) {
      throw new Error('driver is not started, or its stdin has closed');
    }
    stdin.write(promptLine(text));
  }

  /** Close stdin, which tells the CLI no more turns are coming. */
  endInput(): void {
    this.#child?.stdin?.end();
  }

  /** Stop the child. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.#child?.kill(signal);
  }

  /** Everything the CLI has written to stderr so far. */
  get stderr(): string {
    return this.#stderr;
  }

  #onStdout(chunk: Buffer): void {
    this.#emit(this.#framer.push(chunk));
  }

  #emit(frames: ReturnType<NdjsonFramer['push']>): void {
    // Raw frames are inspected for turn boundaries and the CLI's session id
    // BEFORE mapping, because neither survives translation: the `result` frame
    // becomes a usage_update and the `init` frame maps to nothing at all.
    for (const frame of frames) {
      if (!frame.ok) continue;

      const cliSessionId = cliSessionIdOf(frame.value);
      if (cliSessionId !== null) this.cliSessionId = cliSessionId;

      const outcome = turnOutcomeOf(frame.value);
      if (outcome !== null) this.#pendingOutcome = outcome;
    }

    const { updates, problems } = updatesFromFrames(frames, this.#mapper);
    for (const problem of problems) this.#events.onProtocolError?.(problem);
    for (const update of updates) this.#events.onUpdate?.(update);

    // Fired AFTER the updates, so a caller resolving a turn on this signal has
    // already received everything the turn produced -- including the
    // usage_update that the same `result` frame generates. Firing first would
    // resolve session/prompt before its own usage arrived.
    if (this.#pendingOutcome !== null) {
      const outcome = this.#pendingOutcome;
      this.#pendingOutcome = null;
      this.#events.onTurnEnd?.(outcome);
    }
  }

  #onStderr(chunk: string): void {
    this.#stderr += chunk;
    // Line-wise, so a caller can match on a whole message rather than on
    // whatever happened to land in one chunk.
    const lines = chunk.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) this.#events.onStderr?.(line);
  }
}
