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
import { type ChildProcess, spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../env.js';
import { claudeMcpConfig, readMcpServers, type McpServer } from '../mcp.js';
import { assertModel } from '../meta.js';
import { ClaudeTurnFailures, type TurnFailure } from '../turn-failure.js';
import { isValidCliSessionId } from '../session-id.js';
import { randomBytes } from 'node:crypto';
import type { PermissionOutcome, PermissionRequest, ProblemDetail } from '../acp/agent.js';
export type { ProblemDetail } from '../acp/agent.js';
import { ApprovalServer, HOOK_SCRIPT, approvalSettings, permissionRequestFor } from './approvals.js';
import { NdjsonFramer, encodeLine } from '../ndjson.js';
import { type AcpUpdate, ClaudeToAcp } from './to-acp.js';
import type { DriverCapabilities } from '../acp/agent.js';
import { fileAsText, promptBlocks, type PromptBlock, type PromptContent } from '../prompt.js';

/**
 * Claude driver's behavior claim, published by initialize for clients.
 * permissionRequests is currently false; clients should read
 * this declaration rather than branch on a provider name.
 */
export const CLAUDE_DRIVER_CAPABILITIES = {
  permissionRequests: false,
  transcriptReplay: false,
  mcpCapabilities: { http: true, sse: true },
  // Text, images and text files: see {@link promptLine} for the documented shape of each. A binary file has no
  // documented stream-json block, so it is refused rather than sent in an undocumented one.
  promptBlocks: ['text', 'image', 'resource-text'],
  // Turn cancel (issue #16): session/cancel interrupts the turn and keeps the CLI. See {@link ClaudeDriver.cancel} for
  // what is documented and what was measured.
  cancel: true,
} as const satisfies DriverCapabilities;

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
  /** Explicit per-session MCP servers; independent of the agent's environment. */
  readonly mcpServers?: readonly McpServer[];
  readonly permissionMode?: ClaudePermissionMode;
  /**
   * The model to run (`--model`): an alias (`sonnet`, `haiku`) or a full id. Omitted means the CLI's own default. The
   * model actually in use is reported on the init notice as `_meta[particle.academy/model]`.
   */
  readonly model?: string;
  /**
   * Ask a person before these tools run (issue #1): each matching call raises `onRequestPermission`, the same request
   * CodexDriver raises, and runs only on an explicit "allow once". Supplied as a PreToolUse hook for this invocation
   * (`--settings`), over a private socket; anything but an explicit allow denies. Tool names are single identifiers
   * (`Bash`, `WebFetch`, `Write`, ...).
   */
  readonly permissionPrompts?: { readonly tools: readonly string[] };
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
  readonly onProtocolError?: (problem: string, detail?: ProblemDetail) => void;
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
  /**
   * A tool call waits for a person (only with `permissionPrompts`). Resolve with the client's choice; anything but
   * `{ outcome: 'selected', optionId: 'allow_once' }` denies the call.
   */
  readonly onRequestPermission?: (request: PermissionRequest) => Promise<PermissionOutcome>;
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
// ClaudeDriver supplies a private, temporary config file. Custom spawners using
// this helper must supply their own file path for non-empty mcpServers.
export function claudeArgs(options: ClaudeDriverOptions, mcpConfigPath?: string, settingsPath?: string): string[] {
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
  if (options.model !== undefined) args.push('--model', assertModel(options.model));
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push('--allowed-tools', options.allowedTools.join(','));
  }
  if (options.disallowedTools !== undefined && options.disallowedTools.length > 0) {
    args.push('--disallowed-tools', options.disallowedTools.join(','));
  }
  if ((options.mcpServers?.length ?? 0) > 0 && mcpConfigPath === undefined) {
    throw new Error('claudeArgs requires an MCP config file path when mcpServers is non-empty');
  }
  if (mcpConfigPath !== undefined) {
    // shell:true is needed for Windows npm shims. Only a generated file path
    // crosses that shell; JSON values and credentials never become argv.
    if (process.platform === 'win32' && /["%!\r\n\0]/.test(mcpConfigPath)) {
      throw new Error('MCP config file path cannot be represented safely by the Windows shell');
    }
    args.push('--mcp-config', process.platform === 'win32' ? `"${mcpConfigPath}"` : mcpConfigPath);
  }
  if (settingsPath !== undefined) {
    // Same rule as the MCP config: only a generated file path crosses the Windows shell.
    if (process.platform === 'win32' && /["%!\r\n\0]/.test(settingsPath)) {
      throw new Error('settings file path cannot be represented safely by the Windows shell');
    }
    args.push('--settings', process.platform === 'win32' ? `"${settingsPath}"` : settingsPath);
  }

  return args;
}

/**
 * Encode one user turn for `--input-format stream-json`.
 *
 * The CLI expects the same message envelope it emits, not a bare string. Its content is the documented user-message
 * content of the Agent SDK's streaming input (https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode,
 * "Streaming Input Mode"): `text` blocks, and an image as `{ type: 'image', source: { type: 'base64', media_type,
 * data } }`. A text file becomes a text block that names it ({@link fileAsText}). Anything else is refused by
 * {@link promptBlocks} before a byte is written, naming the block.
 */
export function promptLine(content: PromptContent): string {
  const blocks = promptBlocks(content, CLAUDE_DRIVER_CAPABILITIES.promptBlocks);
  return encodeLine({
    type: 'user',
    message: { role: 'user', content: blocks.map(claudeContent) },
  });
}

function claudeContent(block: PromptBlock): Record<string, unknown> {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } };
  }
  // promptBlocks admitted only a text resource here.
  return { type: 'text', text: fileAsText(block.resource as { uri: string; mimeType?: string; text: string }) };
}

/** ACP's five stop reasons. No sixth, and no "unknown". */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface TurnOutcome {
  /** Null when the turn did not finish cleanly -- see {@link turnOutcomeOf}. */
  readonly stopReason: StopReason | null;
  readonly isError: boolean;
  /** The CLI's own reason string, kept even when it maps to nothing. */
  readonly raw: string | null;
  /** Why a failed turn failed, when the provider said (tynn #791). Absent on a turn that completed. */
  readonly failure?: TurnFailure;
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
/**
 * The result terminal reasons that mean the agent loop was ABORTED. Documented values of `SDKResultMessage.terminal_reason`
 * (https://code.claude.com/docs/en/agent-sdk/typescript). `aborted_streaming` is the one measured after an interrupt
 * (2026-10-15); `aborted_tools` is its documented counterpart for an interrupt that lands while a tool runs.
 */
const ABORTED_TERMINAL_REASONS: ReadonlySet<string> = new Set(['aborted_streaming', 'aborted_tools']);

/**
 * The outcome of a turn THIS driver interrupted: the CLI reports it as an error result
 * (`error_during_execution`, `is_error: true`, `stop_reason: null`, `terminal_reason: 'aborted_streaming'` -- the frame
 * measured), and it is a cancelled turn, not a failed one. Null for anything else, including an abort nobody asked for,
 * which stays an error.
 */
function interruptedOutcomeOf(frame: unknown): TurnOutcome | null {
  if (!isObject(frame) || frame.type !== 'result') return null;
  const reason = frame.terminal_reason;
  if (typeof reason !== 'string' || !ABORTED_TERMINAL_REASONS.has(reason)) return null;
  return { stopReason: 'cancelled', isError: false, raw: reason };
}

export function cliSessionIdOf(frame: unknown): string | null {
  if (!isObject(frame) || frame.type !== 'system' || frame.subtype !== 'init') return null;
  return typeof frame.session_id === 'string' ? frame.session_id : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Protect the directory before a credential is written, including Windows ACLs. */
function privateMcpDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'prism-acp-mcp-'));
  try {
    if (process.platform === 'win32') {
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      const env = childEnv(process.env).env;
      const identity = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
        { encoding: 'utf8', windowsHide: true, env });
      const sid = identity.match(/\bS-\d+(?:-\d+)+\b/)?.[0];
      if (sid === undefined) throw new Error('cannot identify the Windows process identity');
      // File modes are ignored on Windows. Remove inherited grants and let
      // only this process identity read/write new files in the directory.
      execFileSync(join(system32, 'icacls.exe'),
        [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
        { stdio: 'pipe', windowsHide: true, env });
    }
    return directory;
  } catch {
    rmdirSync(directory);
    throw new Error('failed to protect the temporary MCP directory');
  }
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
  /** The running turn's failure reason, read from its frames; taken at its `result`. */
  readonly #failures = new ClaudeTurnFailures();
  /** Prompts written whose `result` has not arrived yet. */
  #turnsInFlight = 0;
  /** An interrupt was sent and the turn it targets has not ended yet. */
  #interruptPending = false;
  #controlSequence = 0;
  readonly #mcpServers: readonly McpServer[];
  #mcpConfigDirectory: string | null = null;
  #mcpConfigPath: string | null = null;
  /** The permission-prompt hook's private files and its channel (issue #1); null when not asked for. */
  #approvalDirectory: string | null = null;
  #approvalFiles: string[] = [];
  #approvals: ApprovalServer | null = null;

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
    this.#mcpServers = readMcpServers(options.mcpServers);
    this.#options = { ...options, mcpServers: this.#mcpServers };
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

    if (this.#options.resumeSessionId !== undefined && !isValidCliSessionId(this.#options.resumeSessionId)) {
      this.#events.onProtocolError?.('invalid resumeSessionId: rejected CLI session id shape');
      this.#events.onExit?.(1, null);
      return;
    }

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

    let child: ChildProcess;
    try {
      if (this.#mcpServers.length > 0) {
        this.#mcpConfigDirectory = privateMcpDirectory();
        this.#mcpConfigPath = join(this.#mcpConfigDirectory, 'mcp.json');
        writeFileSync(this.#mcpConfigPath, JSON.stringify(claudeMcpConfig(this.#mcpServers)),
          { mode: 0o600, flag: 'wx' });
      }
      let settingsPath: string | undefined;
      if (this.#options.permissionPrompts !== undefined) {
        const directory = privateMcpDirectory();
        this.#approvalDirectory = directory;
        const hookPath = join(directory, 'approve.cjs');
        settingsPath = join(directory, 'settings.json');
        writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o600, flag: 'wx' });
        this.#approvalFiles.push(hookPath);
        writeFileSync(settingsPath, JSON.stringify(approvalSettings(process.execPath, hookPath, this.#options.permissionPrompts.tools)), { mode: 0o600, flag: 'wx' });
        this.#approvalFiles.push(settingsPath);
        const socket = process.platform === 'win32' ? `\\\\.\\pipe\\prism-acp-${randomBytes(12).toString('hex')}` : join(directory, 'approve.sock');
        const ask = this.#events.onRequestPermission;
        this.#approvals = new ApprovalServer(socket, (input) => (ask ? ask(permissionRequestFor(input)) : Promise.resolve({ outcome: 'cancelled' as const })));
        const channel = this.#approvals.listen();
        // The token travels in the environment, never in argv.
        env.PRISM_ACP_APPROVAL_SOCKET = channel.socket;
        env.PRISM_ACP_APPROVAL_TOKEN = channel.token;
      }
      child = spawn(this.#options.binary ?? 'claude', claudeArgs(this.#options, this.#mcpConfigPath ?? undefined, settingsPath), {
        cwd: this.#options.cwd,
        env,
        // Windows npm installs expose a `.cmd` shim, which needs a shell.
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.#removeMcpConfig();
      this.#removeApprovals();
      // A filesystem/spawn error can contain a sensitive path. Keep the report structural.
      throw new Error('failed to prepare Claude MCP configuration or spawn CLI');
    }
    this.#child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.#onStderr(chunk));

    child.on('error', (cause: Error) => {
      this.#removeMcpConfig();
      this.#removeApprovals();
      // A spawn failure (ENOENT for a missing binary) arrives here and nowhere
      // else. Reported as a protocol error so a caller cannot mistake "the CLI
      // is not installed" for "the agent said nothing".
      this.#events.onProtocolError?.(`failed to spawn: ${cause.message}`);
    });

    child.on('close', (code, signal) => {
      this.#removeMcpConfig();
      this.#removeApprovals();
      // Flush first: a frame can be complete without its trailing newline, and
      // the LAST frame of a turn is the `result` that carries the outcome.
      this.#emit(this.#framer.end());
      this.#events.onExit?.(code, signal);
    });
  }

  /** Send a user turn: text, or content blocks. A block it cannot send refuses the whole turn, naming it. */
  prompt(content: PromptContent): void {
    // Encoded first, so a refused prompt throws PromptRefused whether or not the CLI is running.
    const line = promptLine(content);
    const stdin = this.#child?.stdin;
    if (stdin === null || stdin === undefined) {
      throw new Error('driver is not started, or its stdin has closed');
    }
    stdin.write(line);
    this.#turnsInFlight += 1;
  }

  /**
   * Interrupt the turn in flight and keep the CLI and its session (issue #16).
   *
   * What is DOCUMENTED (https://code.claude.com/docs/en/agent-sdk/typescript): the CLI has a control protocol a client
   * may drive directly, with an `interrupt` control request ("A client that drives the CLI's control protocol directly,
   * rather than through `interrupt()`, can set `cancel_queued: true` on the `interrupt` control request",
   * SDKControlInterruptResponse), and its envelope is `{ type: "control_request", request_id, request }`
   * (SDKControlInitializeResponse).
   *
   * What is NOT in Anthropic's docs: the `request` body, `{ subtype: 'interrupt' }`. It is built on a MEASUREMENT --
   * scripts/probe-claude-interrupt.mjs, run 2026-10-15 on the owner's Claude Code: the request was accepted; the turn
   * ended 11 ms later with `{ subtype: 'error_during_execution', stop_reason: null, terminal_reason:
   * 'aborted_streaming', is_error: true }`, which is mapped here to a cancelled turn; the process stayed alive; the next
   * prompt ran to end_turn. Re-run the probe when the CLI changes.
   *
   * `cancel_queued` is deliberately NOT set. Measured without it, a message queued on stdin at the moment of the
   * interrupt still ran afterwards. Through ACP there is never such a message -- one turn at a time per session -- so
   * the flag would change nothing for session/cancel, and its effect on this CLI has not been measured.
   *
   * Resolves once the request is written; the turn ends through onTurnEnd. Nothing waits on the CLI's
   * control_response, whose shape was not captured. No turn running: nothing is sent.
   */
  cancel(): Promise<void> {
    const stdin = this.#child?.stdin;
    if (this.#turnsInFlight === 0 || stdin === null || stdin === undefined || stdin.destroyed) {
      return Promise.resolve();
    }
    this.#interruptPending = true;
    this.#controlSequence += 1;
    const request = encodeLine({
      type: 'control_request',
      request_id: `prism-acp-interrupt-${this.#controlSequence}`,
      request: { subtype: 'interrupt' },
    });
    return new Promise<void>((resolve, reject) => {
      stdin.write(request, (cause) => (cause ? reject(new Error('failed to write the Claude interrupt request')) : resolve()));
    });
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

  /** The permission-prompt channel closed and its private files removed (issue #1). */
  #removeApprovals(): void {
    this.#approvals?.close();
    this.#approvals = null;
    const files = this.#approvalFiles;
    const directory = this.#approvalDirectory;
    this.#approvalFiles = [];
    this.#approvalDirectory = null;
    for (const file of files) {
      try { unlinkSync(file); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') this.#events.onProtocolError?.('failed to remove a temporary Claude permission-prompt file', { recoverable: true });
      }
    }
    if (directory !== null) {
      // The posix socket file lives here too; the server's close() removes it.
      try { rmdirSync(directory); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') this.#events.onProtocolError?.('failed to remove the temporary Claude permission-prompt directory', { recoverable: true });
      }
    }
  }

  #removeMcpConfig(): void {
    const file = this.#mcpConfigPath;
    const directory = this.#mcpConfigDirectory;
    this.#mcpConfigPath = null;
    this.#mcpConfigDirectory = null;
    for (const [path, remove] of [[file, unlinkSync], [directory, rmdirSync]] as const) {
      if (path === null) continue;
      try { remove(path); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.#events.onProtocolError?.('failed to remove temporary Claude MCP configuration', { recoverable: true });
        }
      }
    }
  }

  #onStdout(chunk: Buffer): void {
    this.#emit(this.#framer.push(chunk));
  }

  #emit(frames: ReturnType<NdjsonFramer['push']>): void {
    const acceptedFrames: typeof frames = [];
    // Raw frames are inspected for turn boundaries and the CLI's session id
    // BEFORE mapping, because neither survives translation: the `result` frame
    // becomes a usage_update and the `init` frame maps to nothing at all.
    for (const frame of frames) {
      if (!frame.ok) {
        acceptedFrames.push(frame);
        continue;
      }

      const cliSessionId = cliSessionIdOf(frame.value);
      if (isObject(frame.value) && frame.value.type === 'system' && frame.value.subtype === 'init' &&
          'session_id' in frame.value && !isValidCliSessionId(cliSessionId)) {
        this.#events.onProtocolError?.('invalid session_id: rejected Claude CLI session id shape');
        // The mapper independently publishes init ids in _meta; do not pass it a rejected frame.
        continue;
      }
      if (cliSessionId !== null) this.cliSessionId = cliSessionId;
      // The CLI's answer to this driver's own control request. Nothing waits on it (see cancel()), and it is not
      // agent output, so it is neither mapped nor filed as unmapped.
      if (isObject(frame.value) && frame.value.type === 'control_response') continue;
      acceptedFrames.push(frame);
      this.#failures.observe(frame.value);

      const outcome = turnOutcomeOf(frame.value);
      if (outcome !== null) {
        this.#turnsInFlight = Math.max(0, this.#turnsInFlight - 1);
        const interrupted = this.#interruptPending ? interruptedOutcomeOf(frame.value) : null;
        this.#interruptPending = false;
        // Taken for every turn, so a reason never leaks into the next one; attached only to a turn that failed.
        const failure = this.#failures.take();
        const settled = interrupted ?? outcome;
        this.#pendingOutcome = settled.isError && failure !== undefined ? { ...settled, failure } : settled;
      }
    }

    const { updates, problems } = updatesFromFrames(acceptedFrames, this.#mapper);
    // A frame that could not be read is ONE lost frame; the stream after it is mapped as normal.
    for (const problem of problems) this.#events.onProtocolError?.(problem, { recoverable: true });
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
