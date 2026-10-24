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
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../env.js';
import { apiKeyEnvironment, apiKeyHome, type ProviderCredentials } from '../credentials.js';
import { restrictToCurrentUser } from '../private-directory.js';
import { claudeMcpConfig, readDisabledMcpServers, readMcpServers, type McpServer } from '../mcp.js';
import { assertModel } from '../meta.js';
import { ClaudeTurnFailures, type TurnFailure } from '../turn-failure.js';
import { isValidCliSessionId } from '../session-id.js';
import { randomBytes } from 'node:crypto';
import type { PermissionOutcome, PermissionRequest, ProblemDetail } from '../acp/agent.js';
export type { ProblemDetail } from '../acp/agent.js';
import { ApprovalServer, HOOK_SCRIPT, approvalSettings, permissionRequestFor } from './approvals.js';
import { NdjsonFramer, encodeLine } from '../ndjson.js';
import { ModelListError, claudeModelsOf, type SessionModelState } from '../models.js';
import { ProcessTreeError, launchProvider, type ProcessTree, type ProviderProcess, type StopOptions, type StopVerdict } from '../process-tree.js';
import { type AcpUpdate, ClaudeToAcp } from './to-acp.js';
import type { DriverCapabilities } from '../acp/agent.js';
import { fileAsText, promptBlocks, type PromptBlock, type PromptContent } from '../prompt.js';

/**
 * Claude driver's behavior claim, published by initialize for clients.
 * permissionRequests is false by default. An embedder enabling permissionPrompts
 * declares that configured capability through serve's driverCapabilities.
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
  /**
   * Arguments placed before the provider's own, for a binary that is an interpreter: `{ binary: process.execPath,
   * binaryArgs: ['/abs/stub.mjs'] }`. The way to run a script provider on Windows, where a `.cmd` that is not an npm
   * shim is refused (it would need cmd.exe, which interprets its arguments).
   */
  readonly binaryArgs?: readonly string[];
  /** Parent environment to build the child's from. Defaults to `process.env`. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Extra environment names to pass through to the child. */
  readonly allowEnv?: readonly string[];
  /** Resume an existing CLI session instead of starting a new one. */
  readonly resumeSessionId?: string;
  /** Explicit per-session MCP servers; independent of the agent's environment. */
  readonly mcpServers?: readonly McpServer[];
  /** Deny these inherited MCP names for this run, preserving unrelated servers and permission hooks. */
  readonly disabledMcpServers?: readonly string[];
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
  /** CLI --allowed-tools permission auto-allow rules; does not restrict the available tool catalog. */
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /**
   * How the CLI authenticates: the person's subscription login (the default), or an API key the app supplies, with
   * an app- or tenant-owned configuration home so the person's own login is never touched. See credentials.ts. App or
   * tenant configuration; never built from what an ACP client sends.
   */
  readonly credentials?: ProviderCredentials;
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
  // Plain paths on every platform. No shell runs the CLI any more (process-tree.ts quotes the argv itself), so the
  // quotes this once added for cmd.exe would now reach the CLI as part of the path.
  if (mcpConfigPath !== undefined) args.push('--mcp-config', mcpConfigPath);
  if (settingsPath !== undefined) args.push('--settings', settingsPath);

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

  // A built-in command (/compact, /context) runs no model turn, so a successful result carries NO stop reason
  // (subtype success, is_error false, num_turns 0). It finished, cleanly: reported as end_turn, because null means
  // "did not finish" and a client reads it that way (tynn, 2026-10-19).
  if (!isError && raw === null && frame.subtype === 'success') return { stopReason: 'end_turn', isError: false, raw };

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
    // File modes are ignored on Windows: only this process identity may read or write the directory.
    restrictToCurrentUser(directory);
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
  #provider: ProviderProcess | null = null;
  #stderr = '';
  #pendingOutcome: TurnOutcome | null = null;
  /** The running turn's failure reason, read from its frames; taken at its `result`. */
  readonly #failures = new ClaudeTurnFailures();
  /** Prompts written whose `result` has not arrived yet. */
  #turnsInFlight = 0;
  /** An interrupt was sent and the turn it targets has not ended yet. */
  #interruptPending = false;
  #controlSequence = 0;
  /** This driver's own control requests awaiting the CLI's control_response, by request_id. */
  readonly #controlWaiters = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: (cause: Error) => void }>();
  /** The account's models, from the control `initialize` answer. Null until started. */
  #models: Promise<SessionModelState['availableModels']> | null = null;
  /** The model this session uses: the `model` option, then whatever setModel() chose. Null = the CLI's default. */
  #currentModelId: string | null = null;
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
    this.#options = { ...options, mcpServers: this.#mcpServers, disabledMcpServers: readDisabledMcpServers(options.disabledMcpServers, this.#mcpServers) };
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

    const parentEnv = this.#options.parentEnv ?? process.env;
    // Checked before anything starts: a key with no usable home is refused here, naming the field, never the key.
    const keyed = apiKeyHome('claude', this.#options.credentials, parentEnv);
    const { env, withheld } = childEnv(parentEnv, {
      allow: [
        // The CLI finds the user's own login through these, so they are allowed
        // explicitly rather than inherited wholesale.
        'CLAUDE_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        ...(this.#options.allowEnv ?? []),
      ],
      // API-key mode: the app's key and the app's home, set explicitly. Inherited credentials stay withheld either way.
      ...(keyed === null ? {} : { set: apiKeyEnvironment('claude', keyed) }),
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
      if (this.#options.permissionPrompts !== undefined || this.#options.disabledMcpServers!.length > 0) {
        const directory = privateMcpDirectory();
        this.#approvalDirectory = directory;
        const hookPath = join(directory, 'approve.cjs');
        settingsPath = join(directory, 'settings.json');
        if (this.#options.permissionPrompts !== undefined) {
          writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o600, flag: 'wx' });
          this.#approvalFiles.push(hookPath);
        }
        const settings = {
          ...(this.#options.permissionPrompts !== undefined ? approvalSettings(process.execPath, hookPath, this.#options.permissionPrompts.tools) : {}),
          ...(this.#options.disabledMcpServers!.length > 0 ? { deniedMcpServers: this.#options.disabledMcpServers!.map((name) => ({ serverName: name })) } : {}),
        };
        writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
        this.#approvalFiles.push(settingsPath);
      }
      if (this.#options.permissionPrompts !== undefined) {
        const directory = this.#approvalDirectory!;
        const socket = process.platform === 'win32' ? `\\\\.\\pipe\\prism-acp-${randomBytes(12).toString('hex')}` : join(directory, 'approve.sock');
        const ask = this.#events.onRequestPermission;
        this.#approvals = new ApprovalServer(socket, (input) => (ask ? ask(permissionRequestFor(input)) : Promise.resolve({ outcome: 'cancelled' as const })));
        const channel = this.#approvals.listen();
        // The token travels in the environment, never in argv.
        env.PRISM_ACP_APPROVAL_SOCKET = channel.socket;
        env.PRISM_ACP_APPROVAL_TOKEN = channel.token;
      }
      // Under a supervisor that owns the whole process tree, and never through a shell (see process-tree.ts).
      this.#provider = launchProvider(this.#options.binary ?? 'claude', [
        ...(this.#options.binaryArgs ?? []),
        ...claudeArgs(this.#options, this.#mcpConfigPath ?? undefined, settingsPath),
      ], {
        cwd: this.#options.cwd,
        env,
      });
      child = this.#provider.child;
    } catch (cause) {
      this.#removeMcpConfig();
      this.#removeApprovals();
      // Its message names no path, and says why the CLI could not be run.
      if (cause instanceof ProcessTreeError) throw cause;
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

    this.#currentModelId = this.#options.model ?? null;
    this.#models = this.#control({ subtype: 'initialize' }).then((response) => {
      // The control_response's `response` is the envelope ({ subtype, request_id, response }); the models are inside.
      if (response.subtype !== 'success') throw new ModelListError('the Claude CLI refused the initialize request');
      return claudeModelsOf(response.response);
    });
    // Nobody may ask for the models; a refusal or an early exit must not become an unhandled rejection.
    this.#models.catch(() => {});

    child.on('close', (code, signal) => {
      for (const waiter of this.#controlWaiters.values()) waiter.reject(new ModelListError('the Claude CLI exited before answering'));
      this.#controlWaiters.clear();
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

  /**
   * The models the signed-in account offers, and which one this session uses -- ACP's session model state. From the
   * CLI's control `initialize` answer (see models.ts for the measurement), sent at start; no turn runs.
   * `currentModelId` is the `model` option or the last setModel(), else the CLI's own `default` entry.
   */
  async modelState(): Promise<SessionModelState> {
    if (this.#models === null) throw new Error('driver is not started');
    const availableModels = await this.#models;
    const current = this.#currentModelId ?? availableModels.find((model) => model.isDefault)?.modelId ?? null;
    return { availableModels, currentModelId: current };
  }

  /**
   * Switch the live session's model; the next turn uses it. The control `set_model` request, MEASURED rather than
   * documented: scripts/probe-claude-models.mjs (claude-code 2.1.301, 2026-10-21) switched a running CLI from its
   * default to haiku, and the next turn's assistant message and result named claude-haiku-5-5. Rejects if the CLI
   * refuses; the id must pass the same check as the `model` option.
   */
  async setModel(modelId: string): Promise<void> {
    const model = assertModel(modelId);
    const response = await this.#control({ subtype: 'set_model', model });
    if (response.subtype !== 'success') throw new Error(`the Claude CLI refused to switch model to ${JSON.stringify(model)}`);
    this.#currentModelId = model;
  }

  /** Send one control request and resolve with the CLI's control_response (its `response` object). */
  #control(request: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const stdin = this.#child?.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed) return Promise.reject(new Error('driver is not started, or its stdin has closed'));
    this.#controlSequence += 1;
    const id = `prism-acp-control-${this.#controlSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#controlWaiters.delete(id);
        reject(new ModelListError(`the Claude CLI did not answer ${String(request.subtype)} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.#controlWaiters.set(id, {
        resolve: (response) => { clearTimeout(timer); resolve(response); },
        reject: (cause) => { clearTimeout(timer); reject(cause); },
      });
      stdin.write(encodeLine({ type: 'control_request', request_id: id, request }));
    });
  }

  /** Close stdin, which tells the CLI no more turns are coming. */
  endInput(): void {
    this.#child?.stdin?.end();
  }

  /** End the CLI and every process it started, now. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.#provider?.kill(signal);
  }

  /**
   * End the CLI and its whole process tree, and say whether anything is left: close stdin, give the CLI `graceMs` to
   * exit on its own, terminate the tree, and resolve once the tree is empty (or the wait gave up -- see the verdict).
   */
  stop(options?: StopOptions): Promise<StopVerdict> {
    if (this.#provider === null) return Promise.resolve({ graceful: true, empty: true, survivors: 0, verified: true });
    return this.#provider.stop(options);
  }

  /** The CLI's pid and what holds its tree; null until it is running. */
  get processTree(): ProcessTree | null {
    return this.#provider?.tree ?? null;
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
      // The CLI's answer to this driver's own control request: handed to whatever waits on it (initialize,
      // set_model; nothing waits on interrupt, see cancel()). Not agent output, so neither mapped nor unmapped.
      if (isObject(frame.value) && frame.value.type === 'control_response') {
        const response = isObject(frame.value.response) ? frame.value.response : undefined;
        const id = typeof response?.request_id === 'string' ? response.request_id : undefined;
        const waiter = id === undefined ? undefined : this.#controlWaiters.get(id);
        if (waiter !== undefined && id !== undefined && response !== undefined) {
          this.#controlWaiters.delete(id);
          waiter.resolve(response);
        }
        continue;
      }
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
