/**
 * The ACP agent surface: `initialize`, `session/new`, `session/load`,
 * `session/prompt`, `session/cancel`.
 *
 * This is the half a client talks to. Underneath, each ACP session owns one
 * driver, which owns one agent-CLI process.
 *
 * ## Several sessions, not one
 *
 * Sessions live in a map from the start, and that is a requirement rather than
 * tidiness. The first consumer of this package needs a room holding SEVERAL
 * agents at once, each its own process with its own in-flight turn and pending
 * approvals. A design that assumed one session per server works perfectly for
 * the first agent and has to be taken apart for the second, so it is not worth
 * writing even as a step.
 *
 * ## Capabilities are claims, so they are reported honestly
 *
 * `initialize` declares what this agent can do, and a client plans around the
 * answer. `loadSession` is the driver's claim ({@link DriverCapabilities.loadSession}): the shipped drivers resume
 * through the CLI's own `--resume` / `thread/resume` and say true; a driver that keeps no sessions says false, and
 * `session/load` is then refused before any driver is built. Anything not implemented is reported absent rather than
 * optimistically.
 */
import { readFileSync } from 'node:fs';
import { JsonRpcPeer, RPC_INVALID_PARAMS, RPC_INTERNAL_ERROR, RPC_METHOD_NOT_FOUND, RpcError } from '../jsonrpc.js';
import type { AcpUpdate } from '../claude/to-acp.js';
import type { StopReason, TurnOutcome } from '../claude/driver.js';
import { META_CLI_SESSION_ID, META_DRIVER_CAPABILITIES, META_MODEL_INFO, META_PERMISSION_REASON, META_TURN_FAILURE, withMeta } from '../meta.js';
import type { SessionModelState } from '../models.js';
import { observeStopVerdict } from '../stop-verdict.js';
import { clientAcceptsPlanUpdates, holdsHiddenCharacter, PLAN_ENTRIES_MAX, PLAN_ENTRY_CONTENT_MAX, PLAN_ENTRY_PRIORITY, PLAN_ID_MAX, PLAN_MARKDOWN_MAX, PLAN_META_MAX_BYTES, PLAN_PATH_MAX, type PlanClient } from '../plan.js';
import { assertMcpSupport, readMcpServers, type McpCapabilities, type McpServer } from '../mcp.js';
import type { ProcessTree, StopOptions, StopVerdict } from '../process-tree.js';
import type { PingOptions } from '../liveness.js';
import { PromptRefused, promptBlockKind, promptBlocks, type PromptBlockKind, type PromptContent } from '../prompt.js';
import { CommandUnsupported } from '../codex/commands.js';
import { wireTurnFailure } from '../turn-failure.js';
import { SteerInputError, SteerUnsupported, safeNativeId, validSteerId, type SteerAcceptance, type SteerOptions, type SteerState, type SteerUpdate, type SteeringState } from '../steer.js';

/** The protocol version this agent speaks. */
export const PROTOCOL_VERSION = 1;

function packageVersion(): string {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly version?: unknown };
    return typeof version === 'string' && version.length > 0 ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** What a driver must offer the agent surface, whichever CLI it drives. */
export interface AgentDriver {
  start(): void;
  /**
   * One user turn. A prompt of text blocks only arrives as their text, joined -- the shape every driver has always
   * taken. Content blocks arrive only when the driver declares their kinds in `promptBlocks`; a driver may still throw
   * {@link PromptRefused} for a block it cannot send, and the client is told which.
   */
  prompt(content: PromptContent): void;
  /** Native operation acceptance; completion still arrives through onTurnEnd. Codex supports compact/review on its measured CLI. */
  runCommand?(name: string): Promise<void>;
  steer?(content: PromptContent, options: SteerOptions): Promise<SteerAcceptance>;
  readonly steeringState?: SteeringState;
  steerState?(steerId: string): SteerState;
  acknowledgeSteer?(steerId: string): boolean;
  /**
   * Interrupt the turn in flight, leaving the agent process and its session alive (issue #16). The turn still ends
   * through `onTurnEnd` -- with `stopReason: 'cancelled'` once the agent confirms -- and the next prompt runs as
   * normal. Resolves once the agent has accepted the interrupt; rejects if it refused. With no turn running it is a
   * no-op.
   *
   * Optional, and absent on a driver whose agent has no known way to interrupt a turn: there, `session/cancel` stops
   * the agent instead. Declare which in {@link DriverCapabilities.cancel}. Both shipped drivers implement it.
   */
  cancel?(): Promise<void>;
  endInput(): void;
  /** End the agent and every process it started. */
  kill(signal?: NodeJS.Signals): void;
  /**
   * End the agent and its whole process tree, and say whether anything is left. Both shipped drivers implement it; see
   * {@link StopVerdict}.
   */
  stop?(options?: StopOptions): Promise<StopVerdict>;
  /** The agent's pid and what holds its process tree, for a host that records them. Null until running. */
  readonly processTree?: ProcessTree | null;
  /** The models the signed-in account offers, and which one this session uses. Both shipped drivers implement it. */
  modelState?(): Promise<SessionModelState>;
  /** Switch the live session's model. Both shipped drivers implement it (Codex applies it from the next turn). */
  setModel?(modelId: string): Promise<void>;
  /**
   * Re-read the account's rate limits now and emit them as the driver's usual rate-limit notice, without starting a
   * turn. For a host holding a session on a spent window whose agent reports limits only during turns. Optional:
   * present means the reading can be refreshed on demand. CodexDriver implements it; ClaudeDriver does not need to,
   * because Claude's reported resets are accurate.
   */
  readRateLimits?(): Promise<void>;
  /**
   * Liveness (G-314): whether the agent process still answers a harmless read-only request. Resolves true or false and
   * never rejects; side-effect free and safe mid-turn. Both shipped drivers implement it; see liveness.ts.
   */
  ping?(options?: PingOptions): Promise<boolean>;
  /** Epoch ms of the agent's last stdout frame; undefined before the first. Both shipped drivers implement it. */
  readonly lastFrameAt?: number | undefined;
  /** Whether the agent process has been spawned and has not exited. Both shipped drivers implement it. */
  readonly running?: boolean;
  readonly cliSessionId: string | null;
  readonly withheldCredentials: readonly string[];
}

/**
 * What a problem report means for the session. `recoverable: true` = ONE thing was lost (a frame that could not be
 * read, a temporary file that could not be removed) and the session goes on; a client should show it, not call the
 * session dead. Absent = no such claim: the problem may be fatal (a failed spawn, a refused handshake).
 */
export interface ProblemDetail {
  readonly recoverable: boolean;
}

export interface DriverEvents {
  readonly onSteerUpdate?: (update: SteerUpdate) => void;
  readonly onUpdate?: (update: AcpUpdate) => void;
  /** Ask the ACP client to decide a Codex permission request. */
  readonly onRequestPermission?: (
    request: PermissionRequest,
  ) => Promise<PermissionOutcome>;
  readonly onTurnEnd?: (outcome: TurnOutcome) => void;
  readonly onProtocolError?: (problem: string, detail?: ProblemDetail) => void;
  /** Observation only; emitted once after the driver's idempotent stop settles. */
  readonly onStopVerdict?: (verdict: StopVerdict) => void;
  readonly onStderr?: (line: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface PermissionRequest {
  readonly toolCall: Record<string, unknown>;
  readonly options: readonly Record<string, unknown>[];
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/**
 * The client's answer to a permission request. `reason` is what the agent is told about the answer, in place of the
 * default "The person denied this tool call." or "Allowed by the person." Use it when the decision is not the
 * person's -- a limit the client enforces, or an allow it made without asking -- so the agent is told the truth. It
 * never changes the decision itself. An empty string counts as absent.
 *
 * Where it reaches the provider: Claude, always (the hook's decision reason). Codex, only on a refusal through the
 * legacy approval methods, where a rejection carries text; Codex's allows and its v2 decisions carry no text.
 */
export type PermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string; readonly reason?: string }
  | { readonly outcome: 'cancelled'; readonly reason?: string };

/**
 * Builds a driver for one session.
 *
 * Injected rather than hardcoded because this surface fronts more than one
 * CLI, including Codex's `app-server`, and because a server
 * that could only be tested by spawning a real agent would have its session
 * bookkeeping covered by nothing.
 */
export type DriverFactory = (
  options: {
    readonly cwd: string;
    readonly resumeSessionId?: string;
    readonly mcpServers?: readonly McpServer[];
    /**
     * What the client said it can receive, from its `initialize`. `plan: true` means `plan_update` and
     * `plan_removed` may be sent (see plan.ts); AcpAgent enforces it on every update either way.
     */
    readonly clientCapabilities?: PlanClient;
  },
  events: DriverEvents,
) => AgentDriver;

/**
 * Whether a session id names a conversation that can be resumed.
 *
 * Injected, and for two reasons. Tests must not read the developer's real
 * session store; and the answer is a property of the AGENT being driven, not of
 * ACP -- a Codex driver resolves it through `thread/resume`, not through
 * claude's `~/.claude/projects` layout. The store helper is Claude-specific;
 * Codex users should omit it and let the driver check the App Server identity.
 */
export type SessionProbe = (
  sessionId: string,
) => { readonly existence: 'present' | 'absent' | 'indeterminate'; readonly detail: string };

export interface AcpAgentOptions {
  readonly driverFactory: DriverFactory;
  readonly driverCapabilities?: DriverCapabilities;
  readonly probeSession?: SessionProbe;
  readonly agentInfo?: { readonly name: string; readonly title?: string; readonly version: string };
  /** Generate a session id. Injected so tests can assert on stable ids. */
  readonly newSessionId?: () => string;
  readonly onStderr?: (sessionId: string, line: string) => void;
  readonly onProtocolError?: (sessionId: string, problem: string, detail?: ProblemDetail) => void;
  /** Host observation, with no ACP wire extension. Throwing/rejecting observers are isolated. */
  readonly onStopVerdict?: (sessionId: string, verdict: StopVerdict) => void;
}

/** Provider differences clients need to know. */
export interface DriverCapabilities {
  /** Explicit steering API exists; inspect runtime steeringState for the installed CLI's support. */
  readonly steer?: boolean;
  readonly permissionRequests: boolean;
  readonly transcriptReplay: boolean;
  readonly mcpCapabilities?: McpCapabilities;
  /** The prompt block kinds the driver sends. Absent means text only. */
  readonly promptBlocks?: readonly PromptBlockKind[];
  /**
   * Whether `session/cancel` ends only the TURN, keeping the agent and its session (true), or has to stop the agent to
   * stop the turn (false). A client labels Stop from this. Absent means the embedder did not say.
   */
  readonly cancel?: boolean;
  /**
   * Whether `session/load` can resume a session. False: `initialize` advertises `loadSession: false`, and
   * `session/load` is refused (method not found) before the driver factory is called. Absent means true, which is
   * what this package advertised before the field existed; a driver that cannot resume must say so.
   */
  readonly loadSession?: boolean;
}

interface Session {
  readonly id: string;
  readonly cwd: string;
  readonly driver: AgentDriver;
  /** Resolver for the turn currently in flight, if any. */
  turn: { settle: (outcome: TurnOutcome) => void; cancelled: boolean } | null;
  exited: boolean;
}

/**
 * The shape `#sessionNew` mints: `sess_<counter>_<epoch ms>`.
 *
 * Deliberately narrow. A broader "does not look like a UUID" test would refuse
 * a session TITLE, which the CLI accepts alongside a UUID -- so this refuses
 * only the ids this server is known to have handed out and which provably
 * cannot resume.
 */
const MINTED_SESSION_ID = /^sess_\d+_\d+$/;

/** ACP's plan entry priorities. */
const PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
/** ACP's plan entry statuses. A failed or skipped step has none of its own; see plan.ts. */
const PLAN_ENTRY_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);
const MALFORMED_ENTRIES = 'plan update was not sent: an entry was not an object with a string content, an ACP status and an object _meta';
const MALFORMED_META = 'plan update was not sent: its _meta was not an object that serializes as one';
const MALFORMED_READ = 'plan update was not sent: reading it threw';
const OVERSIZE_CONTENT = `plan update was not sent: an entry content is larger than ${PLAN_ENTRY_CONTENT_MAX} code points`;
const OVERSIZE_META = `plan update was not sent: a _meta is larger than ${PLAN_META_MAX_BYTES} bytes of JSON`;
const MALFORMED_SNAPSHOT = 'update was not sent: it does not serialize as an object of the kind it declares';
const OVERSIZE_ENTRIES = `plan update was not sent: it has more than ${PLAN_ENTRIES_MAX} entries`;
const OVERSIZE_MARKDOWN = `plan update was not sent: its markdown content is larger than ${PLAN_MARKDOWN_MAX} code points or its path larger than ${PLAN_PATH_MAX}`;
const OVERSIZE_PLAN_ID = `plan update was not sent: its planId is larger than ${PLAN_ID_MAX} code points`;
const HIDDEN_PLAN_ID = 'plan update was not sent: its planId holds a control, format or invisible character';
const HIDDEN_MARKDOWN = 'plan update was not sent: its markdown path holds a control, format or invisible character, or its content a control or bidi character';
/**
 * What markdown plan content may not hold: C0 and C1 controls other than tab and line feed, and a carriage return not
 * followed by a line feed (a terminal acts on ESC, and a bare CR overwrites the line it ends); bidi embeddings,
 * overrides, isolates and marks (they reorder what is shown); the deprecated format characters and interlinear
 * annotation marks; the line and paragraph separators, the BOM and lone surrogates. Line breaks (LF, CRLF) and
 * zero-width joiners stay: markdown and emoji need them.
 */
const MARKDOWN_HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F\u2028\u2029\uFEFF\uFFF9-\uFFFB\uD800-\uDFFF]|\r(?!\n)/u;

/** Why a planId may not be sent, or undefined: over the cap, or holding a character a client would not show. */
function planIdProblem(planId: string): string | undefined {
  if (longerThan(planId, PLAN_ID_MAX)) return OVERSIZE_PLAN_ID;
  return holdsHiddenCharacter(planId) ? HIDDEN_PLAN_ID : undefined;
}

/**
 * A property the object itself holds, read once. Inherited values are not read: a check that sees them passes an
 * entry whose copy then loses them, and a getter could answer the check and the copy differently.
 */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * `_meta` as ACP allows it: absent or null (both mean none, and are sent as none), or a plain object that serializes
 * as an object. What is returned is that serialization read back -- a fresh object holding exactly what the wire
 * would carry -- so an own `toJSON`, a nested value JSON cannot hold (a BigInt), or a getter or Proxy that throws is
 * caught here and refused, not discovered by the client or thrown at send time.
 */
function planMeta(value: unknown): { ok: boolean; problem?: string; meta?: Record<string, unknown> } {
  if (value === undefined || value === null) return { ok: true };
  const object = asObject(value);
  if (object === undefined) return { ok: false, problem: MALFORMED_META };
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) return { ok: false, problem: MALFORMED_META };
  let text: string | undefined;
  let wire: unknown;
  try {
    text = JSON.stringify(object);
    wire = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    return { ok: false, problem: MALFORMED_META };
  }
  const meta = asObject(wire);
  if (meta === undefined || text === undefined) return { ok: false, problem: MALFORMED_META };
  return utf8Bytes(text) > PLAN_META_MAX_BYTES ? { ok: false, problem: OVERSIZE_META } : { ok: true, meta };
}

/** UTF-8 length of a string. A UTF-16 code unit never takes fewer bytes, so a long string is answered without encoding. */
function utf8Bytes(text: string): number {
  return text.length > PLAN_META_MAX_BYTES ? text.length : new TextEncoder().encode(text).length;
}

/** Whether a string holds more than `max` code points, read no further than that. */
function longerThan(text: string, max: number): boolean {
  if (text.length <= max) return false;
  let count = 0;
  for (let index = 0; index < text.length; index += text.codePointAt(index)! > 0xffff ? 2 : 1) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

type CheckedEntry = { content: string; priority: string | undefined; status: string; _meta?: Record<string, unknown> };

/**
 * Each entry as ACP can carry it (priority aside, which the gate supplies) and within the caps, read from own
 * properties only; or the problem with the first entry that is not.
 */
function checkedPlanEntries(entries: readonly unknown[]): CheckedEntry[] | string {
  // Counted before any entry is read: a model-written plan can hold any number of steps, and every update replaces the
  // client's whole plan.
  // The length is read ONCE and the entries by index: an own iterator, or a Proxy answering `length` differently each
  // time, would otherwise pass the count and then yield any number of entries.
  const count: unknown = entries.length;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return MALFORMED_ENTRIES;
  if (count > PLAN_ENTRIES_MAX) return OVERSIZE_ENTRIES;
  const out: CheckedEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index];
    const object = asObject(entry);
    if (object === undefined) return MALFORMED_ENTRIES;
    const content = own(object, 'content'), status = own(object, 'status'), priority = own(object, 'priority');
    const meta = planMeta(own(object, '_meta'));
    if (typeof content !== 'string' || typeof status !== 'string' || !PLAN_ENTRY_STATUSES.has(status)) return MALFORMED_ENTRIES;
    if (!meta.ok) return meta.problem === OVERSIZE_META ? OVERSIZE_META : MALFORMED_ENTRIES;
    if (longerThan(content, PLAN_ENTRY_CONTENT_MAX)) return OVERSIZE_CONTENT;
    out.push({ content, status, priority: typeof priority === 'string' ? priority : undefined, ...(meta.meta === undefined ? {} : { _meta: meta.meta }) });
  }
  return out;
}

export class AcpAgent {
  readonly #peer: JsonRpcPeer;
  readonly #options: AcpAgentOptions;
  readonly #sessions = new Map<string, Session>();
  #counter = 0;
  /** Ids this process handed out via session/new. See the refusal in #sessionLoad. */
  readonly #minted = new Set<string>();
  /** Whether the client advertised `clientCapabilities.plan` (G-362). False until it says so. */
  #clientAcceptsPlan = false;

  constructor(peer: JsonRpcPeer, options: AcpAgentOptions) {
    this.#peer = peer;
    this.#options = options;

    peer
      .handle('initialize', (params) => this.#initialize(params))
      .handle('authenticate', () => this.#authenticate())
      .handle('session/new', async (params) => await this.#withModels(this.#sessionNew(params)))
      .handle('session/load', async (params) => await this.#withModels(this.#sessionLoad(params), asString(asObject(params)?.sessionId)))
      .handle('session/set_model', async (params) => await this.#sessionSetModel(params))
      .handle('session/prompt', async (params) => await this.#sessionPrompt(params));

    peer.handle('_particle.academy/session/steer', (params) => this.#sessionSteer(params))
      .handle('_particle.academy/session/steer_state', (params) => this.#sessionSteerState(params, false))
      .handle('_particle.academy/session/acknowledge_steer', (params) => this.#sessionSteerState(params, true));

    peer.onNotify('session/cancel', (params) => this.#sessionCancel(params));
  }

  /** Session ids currently open. */
  get sessionIds(): readonly string[] {
    return [...this.#sessions.keys()];
  }

  #steerSession(params: unknown): { session: Session; object: Record<string, unknown> } {
    const object = asObject(params), id = asString(object?.sessionId);
    const session = id === undefined ? undefined : this.#sessions.get(id);
    if (object === undefined || session === undefined || session.exited || 'threadId' in object) {
      throw new RpcError(RPC_INVALID_PARAMS, 'steering requires an owned live session');
    }
    return { session, object };
  }

  async #sessionSteer(params: unknown): Promise<SteerAcceptance> {
    const { session, object } = this.#steerSession(params);
    if (session.driver.steer === undefined) throw new RpcError(RPC_INVALID_PARAMS, 'steer_unsupported');
    if (!validSteerId(object.clientId) || !safeNativeId(object.expectedTurnId)) {
      throw new RpcError(RPC_INVALID_PARAMS, 'steering requires clientId and expectedTurnId');
    }
    try {
      return await session.driver.steer(this.#promptContent(object.prompt), { clientId: object.clientId, expectedTurnId: object.expectedTurnId });
    } catch (cause) {
      // Private native failures/input paths are never reflected through the ACP error channel.
      throw new RpcError(RPC_INVALID_PARAMS, cause instanceof SteerUnsupported ? 'steer_unsupported'
        : cause instanceof SteerInputError ? 'invalid_input' : 'steering request failed');
    }
  }

  #sessionSteerState(params: unknown, acknowledge: boolean): unknown {
    const { session, object } = this.#steerSession(params);
    if (session.driver.steerState === undefined || session.driver.acknowledgeSteer === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, 'steer_unsupported');
    }
    if (object.clientId === undefined && !acknowledge) return session.driver.steeringState;
    if (!validSteerId(object.clientId)) throw new RpcError(RPC_INVALID_PARAMS, 'steering requires a UUID clientId');
    return acknowledge ? { acknowledged: session.driver.acknowledgeSteer(object.clientId) } : session.driver.steerState(object.clientId);
  }

  /** Stop every session's process. */
  closeAll(): void {
    for (const session of this.#sessions.values()) session.driver.kill();
    this.#sessions.clear();
  }

  #initialize(params: unknown): Record<string, unknown> {
    const requested = asObject(params)?.protocolVersion;
    // The spec negotiates: an agent answers with the version it will speak. We
    // speak 1, and say so whatever was asked, rather than echoing a number we
    // do not implement back at the client.
    void requested;
    this.#clientAcceptsPlan = clientAcceptsPlanUpdates(asObject(params)?.clientCapabilities);

    const response = {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: this.#options.agentInfo ?? {
        name: '@particle-academy/prism-acp',
        title: 'Prism ACP',
        version: packageVersion(),
      },
      // Empty because this agent needs no authentication STEP: the CLI it
      // drives is already authenticated by the user, and no credential ever
      // travels in this protocol. Empty is the honest answer, not a placeholder.
      authMethods: [],
      agentCapabilities: {
        ...(this.#options.driverCapabilities?.mcpCapabilities === undefined ? {} : {
          mcpCapabilities: this.#options.driverCapabilities.mcpCapabilities,
        }),
        // True, and PROVEN rather than wired. A live test stores a number in
        // one turn, resumes, and asks for it back -- an assertion a fresh
        // conversation cannot satisfy. That test exists because a wrong resume
        // does not error: it starts a new conversation while the caller
        // believes it continued one, so the flag being set proves nothing on
        // its own. A capability reported optimistically is worse than one
        // reported absent, because a client plans around the answer.
        //
        // A driver that cannot resume says so, and the flag follows its claim (see #sessionLoad's refusal).
        loadSession: this.#resumable(),
        promptCapabilities: {
          // From the driver's own declaration. Reported false rather than
          // omitted, because the client needs to know we will refuse it.
          image: this.#accepts().includes('image'),
          audio: false,
          embeddedContext: this.#accepts().some((kind) => kind === 'resource-text' || kind === 'resource-blob'),
        },
      },
    };

    const capabilities = this.#options.driverCapabilities;
    if (capabilities === undefined) {
      // No declaration means the embedder did not identify a driver; inventing
      // false values here would turn missing information into a provider claim.
      return response;
    }
    return withMeta(response, { [META_DRIVER_CAPABILITIES]: capabilities });
  }

  #authenticate(): null {
    // Reachable only if a client ignores the empty authMethods above. Answering
    // null rather than erroring keeps a confused client working, since there is
    // genuinely nothing to authenticate.
    return null;
  }

  #sessionNew(params: unknown): Record<string, unknown> {
    const cwd = requireAbsoluteCwd(params);
    const mcpServers = this.#mcpServers(params);
    const id = this.#options.newSessionId?.() ?? `sess_${++this.#counter}_${Date.now()}`;
    this.#open(id, cwd, undefined, mcpServers);
    this.#minted.add(id);
    return { sessionId: id };
  }

  /**
   * ACP's (unstable) session model state on a session/new or session/load result: `models: { availableModels,
   * currentModelId }`, from the provider itself (see models.ts), so a client lists what the account really offers.
   * Waited for at most 10 s, and LEFT OUT -- never invented -- if the driver cannot say; the session works either way.
   */
  async #withModels(result: Record<string, unknown>, loadedId?: string): Promise<Record<string, unknown>> {
    const id = loadedId ?? asString(result.sessionId);
    const driver = id === undefined ? undefined : this.#sessions.get(id)?.driver;
    if (driver?.modelState === undefined) return result;
    let timer: NodeJS.Timeout | undefined;
    try {
      const state = await Promise.race([
        driver.modelState(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10_000); }),
      ]);
      if (state === null) {
        this.#options.onProtocolError?.(id!, 'the agent did not report its models within 10 s', { recoverable: true });
        return result;
      }
      return { ...result, models: acpModels(state) };
    } catch (cause) {
      this.#options.onProtocolError?.(id!, `the agent could not report its models (${messageOf(cause)})`, { recoverable: true });
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** ACP's (unstable) `session/set_model`: switch a live session's model. The result is an empty object. */
  async #sessionSetModel(params: unknown): Promise<Record<string, unknown>> {
    const object = asObject(params);
    const sessionId = asString(object?.sessionId);
    const modelId = asString(object?.modelId);
    if (sessionId === undefined || modelId === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, 'session/set_model requires a sessionId and a modelId');
    }
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.exited) throw new RpcError(RPC_INVALID_PARAMS, `no live session: ${sessionId}`);
    if (session.driver.setModel === undefined) throw new RpcError(RPC_INVALID_PARAMS, 'this agent cannot switch models');
    try {
      await session.driver.setModel(modelId);
    } catch (cause) {
      throw new RpcError(RPC_INVALID_PARAMS, messageOf(cause));
    }
    return {};
  }

  /** Whether the driver can resume. Absent means true: see {@link DriverCapabilities.loadSession}. */
  #resumable(): boolean {
    return this.#options.driverCapabilities?.loadSession !== false;
  }

  #sessionLoad(params: unknown): Record<string, unknown> {
    // FIRST, before reading anything: a driver that declared it cannot resume is never asked to, so no factory runs
    // and no half-open session exists. The same answer initialize gave, at the point a client ignores it.
    if (!this.#resumable()) {
      throw new RpcError(RPC_METHOD_NOT_FOUND, 'this agent cannot resume a session: it advertises loadSession false');
    }
    const object = asObject(params);
    const cwd = requireAbsoluteCwd(params);
    const mcpServers = this.#mcpServers(params);
    const sessionId = asString(object?.sessionId);
    if (sessionId === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, 'session/load requires a sessionId');
    }

    // Resuming an id this server already has open would leave two processes
    // writing updates for one session, and the second would look like the
    // first stuttering.
    // Refused only while the session is genuinely LIVE. A session whose agent
    // process has exited is the main thing anyone resumes -- a crashed or
    // killed agent, or one lost to a restart -- and refusing that as "already
    // open" described the map rather than reality: an exited session is never
    // removed from it, only flagged. The old check made the one case resume
    // exists for the one case it rejected.
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined && !existing.exited) {
      throw new RpcError(
        RPC_INVALID_PARAMS,
        `session ${sessionId} is already open and its agent is still running`,
      );
    }

    // The same refusal, by the CLI's id rather than ACP's.
    //
    // The sessions map is keyed by the ACP session id, so a lookup for a CLI id
    // never matched a session opened by `session/new` -- meaning a client
    // resuming a conversation whose agent was STILL RUNNING got a second agent
    // on the same conversation, with no collision reported. That was
    // unreachable while nothing could obtain a CLI id to resume with, and
    // publishing the id is exactly what makes it reachable. Fixing the one
    // without the other would have traded a dead end for two processes writing
    // updates for one conversation.
    for (const session of this.#sessions.values()) {
      if (!session.exited && session.driver?.cliSessionId === sessionId) {
        throw new RpcError(
          RPC_INVALID_PARAMS,
          `session ${sessionId} is already open as ${session.id} and its agent is still running`,
        );
      }
    }

    // REFUSE an id this server minted, because the provider's resume mechanism
    // cannot take it: `session/new` returns an id of OUR making, while the
    // driver resumes with the provider's own captured id. A client that stored
    // the id it was handed and passed it back here was the obvious thing to do
    // and could never have worked.
    //
    // Refused HERE rather than left to the CLI, even though the CLI does error
    // on it (verified: "is not a UUID and does not match any session title",
    // and "No conversation found with session ID" for a well-formed one that
    // does not exist -- it never silently starts a fresh conversation). That
    // error arrives when the FIRST PROMPT runs, by which point `session/load`
    // has already returned success and the client believes it has a resumed
    // session. Moving the refusal to the load makes the failure land where the
    // mistake was made, and the message can say what to pass instead -- which
    // the CLI's cannot, because the CLI has never heard of ACP.
    // Two tests, because neither alone is enough. The PATTERN catches the
    // default mint and survives a restart, which is the case that matters most
    // -- but an embedder supplying its own `newSessionId` is not covered by it.
    // The SET catches any id this process actually handed out, whatever its
    // shape, and does not survive a restart.
    //
    // Nothing covers "an id minted by a previous process using an injected
    // generator", and nothing can: this server cannot tell such a string from a
    // CLI session title by inspection. That residue is exactly why the CLI's
    // own id is published in `_meta` rather than left to be guessed at.
    if (MINTED_SESSION_ID.test(sessionId) || this.#minted.has(sessionId)) {
      throw new RpcError(
        RPC_INVALID_PARAMS,
        `${sessionId} is an ACP session id minted by this server and cannot be resumed by the provider. ` +
          `Resume with the CLI's own session id, sent as '${META_CLI_SESSION_ID}' in the _meta of the first ` +
          `session/update of the original session.`,
      );
    }

    // REFUSE an id that names no conversation, here rather than a turn later.
    //
    // Without this the agent starts, `session/load` returns success, and the
    // CLI's "No conversation found with session ID" arrives when the first
    // prompt runs -- a real error, but one a client cannot tell from any other
    // late failure, and one that lands after it has been told it holds a
    // resumed session. A consumer reported this as the only thing standing
    // between a bad id and a lost conversation.
    //
    // `indeterminate` deliberately PROCEEDS. The probe reads a store whose
    // layout is undocumented, so a store it cannot read must not be allowed to
    // refuse a resume that would have worked; the late error is still there as
    // the backstop it always was. Only a positive `absent` refuses.
    const probe = this.#options.probeSession?.(sessionId);
    if (probe?.existence === 'absent') {
      throw new RpcError(RPC_INVALID_PARAMS, `cannot resume ${sessionId}: ${probe.detail}`);
    }

    this.#open(sessionId, cwd, sessionId, mcpServers);
    // The spec's result is an empty object; history arrives as session/update
    // notifications. Whether the driver replays transcript history is
    // provider-specific: Claude replays none; Codex replays through its paged
    // App Server endpoints.
    return {};
  }

  #mcpServers(params: unknown): readonly McpServer[] {
    const servers = readMcpServers(asObject(params)?.mcpServers);
    const capabilities = this.#options.driverCapabilities?.mcpCapabilities;
    if (capabilities !== undefined) assertMcpSupport(servers, capabilities);
    return servers;
  }

  #open(id: string, cwd: string, resumeSessionId: string | undefined, mcpServers: readonly McpServer[]): Session {
    const session: Session = {
      id,
      cwd,
      driver: undefined as unknown as AgentDriver,
      turn: null,
      exited: false,
    };

    const driver = this.#options.driverFactory(
      { cwd, mcpServers, clientCapabilities: { plan: this.#clientAcceptsPlan }, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) },
      {
        onUpdate: (update) => {
          const sent = this.#planGate(id, update);
          if (sent !== null) this.#peer.notify('session/update', { sessionId: id, update: sent });
        },
        onRequestPermission: async (request) => {
          const result = await this.#peer.request('session/request_permission', {
            sessionId: id,
            ...request,
          });
          const outcome = asObject(result)?.outcome;
          if (!isPermissionOutcome(outcome)) return { outcome: 'cancelled' };
          // Built fresh, so nothing else on the client's object travels inward.
          const reason = asString(asObject(asObject(result)?._meta)?.[META_PERMISSION_REASON]);
          const base: PermissionOutcome = outcome.outcome === 'cancelled'
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId: outcome.optionId };
          return reason === undefined || reason === '' ? base : { ...base, reason };
        },
        onTurnEnd: (outcome) => {
          // A turn the CLI started itself (G-313) answers no session/prompt: its output and usage already went out as
          // session/update, and settling the client's pending prompt with it would end that prompt early.
          if (outcome.unsolicited === true) return;
          const turn = session.turn;
          session.turn = null;
          // ACP: once the client has cancelled, the prompt is answered `cancelled` -- including when the turn
          // finished or failed in the race with the interrupt. The agent's own reason is kept in `raw`.
          turn?.settle(turn.cancelled ? { stopReason: 'cancelled', isError: false, raw: outcome.raw } : outcome);
        },
        onStderr: (line) => this.#options.onStderr?.(id, line),
        onProtocolError: (problem, detail) => this.#options.onProtocolError?.(id, problem, detail),
        onStopVerdict: verdict => observeStopVerdict(value => this.#options.onStopVerdict?.(id, value), verdict),
        onExit: (code) => {
          session.exited = true;
          // A turn still in flight when the process dies must be settled, or
          // session/prompt never returns and the client waits forever on an
          // agent that no longer exists.
          const turn = session.turn;
          session.turn = null;
          turn?.settle({
            stopReason: null,
            isError: true,
            raw: `agent exited with code ${String(code)}`,
          });
        },
      },
    );

    (session as { driver: AgentDriver }).driver = driver;
    this.#sessions.set(id, session);
    driver.start();
    return session;
  }

  /**
   * Plan updates, held to the protocol at the one place every driver's updates leave (G-362). `plan_update` and
   * `plan_removed` MUST NOT reach a client that did not advertise `clientCapabilities.plan`: an items update becomes
   * the full-replacement `plan` it is equivalent to, and anything else is not sent. A plan_update that is not ACP's
   * shape is never sent, and neither is a plan (of either kind) with an entry that is not an object with a string
   * `content` and a status of `pending`, `in_progress` or `completed`, nor one whose `_meta` (entry, plan or update)
   * is present and not a plain object that serializes as an object (it is sent as that serialization, read back).
   * `plan_removed` is held to the same rules. An entry `content` over {@link PLAN_ENTRY_CONTENT_MAX} code points, or a
   * `_meta` over {@link PLAN_META_MAX_BYTES} bytes of JSON, refuses the update. Fields are read from own properties
   * only, a read that throws refuses the update, and what is sent is built from the checked fields, never a copy of
   * the driver's object. Every other update is sent as its JSON serialization read back, and only if that is an
   * object of the kind that was checked. A plan entry with no valid priority is given `medium`, because a client
   * built from the schema drops it otherwise. Each refusal and correction is reported, so a driver that needs one is
   * visible.
   */
  #planGate(sessionId: string, update: AcpUpdate): AcpUpdate | null {
    // A getter or Proxy in the driver's object can throw on any read. That is the driver's fault, not the client's,
    // and it must not escape into the driver's event path: the update is not sent, and that is reported.
    try {
      return this.#checkPlan(sessionId, update);
    } catch {
      this.#reportPlan(sessionId, MALFORMED_READ);
      return null;
    }
  }

  /**
   * Report a plan gate problem through the host's `onProtocolError`. The host's reporter throwing is the host's own
   * fault: it is contained here, so it neither reaches the driver nor reads as the driver's update having thrown.
   */
  #reportPlan(sessionId: string, problem: string): void {
    try {
      this.#options.onProtocolError?.(sessionId, problem, { recoverable: true });
    } catch {
      // Nothing left to report it to.
    }
  }

  #checkPlan(sessionId: string, update: AcpUpdate): AcpUpdate | null {
    const refuse = (problem: string): null => {
      this.#reportPlan(sessionId, problem);
      return null;
    };
    // What is sent is built here from the fields checked here, read from own properties only, never a copy of the
    // driver's object: a copy would carry whatever the check did not look at.
    const withMeta = <T extends Record<string, unknown>>(body: T, meta: Record<string, unknown> | undefined) =>
      meta === undefined ? body : { ...body, _meta: meta };
    // The kind is read once, from the update's own property, and the update sent carries that same kind: a getter or
    // Proxy cannot answer this switch with a chunk and the serializer with a plan.
    const kind = own(update as unknown as Record<string, unknown>, 'sessionUpdate');
    if (typeof kind !== 'string') return refuse('update without a string sessionUpdate of its own was not sent');
    switch (kind) {
      case 'plan': {
        const list = own(update, 'entries');
        if (!Array.isArray(list)) return refuse('plan update without an entries list was not sent');
        const checked = checkedPlanEntries(list);
        if (typeof checked === 'string') return refuse(checked);
        const meta = planMeta(own(update, '_meta'));
        if (!meta.ok) return refuse(meta.problem!);
        return withMeta({ sessionUpdate: 'plan', entries: this.#planEntries(sessionId, checked) }, meta.meta);
      }
      case 'plan_update': {
        const plan = asObject(own(update, 'plan'));
        const type = plan === undefined ? undefined : own(plan, 'type');
        const planId = plan === undefined ? undefined : asString(own(plan, 'planId'));
        const list = plan === undefined ? undefined : own(plan, 'entries');
        const content = plan === undefined ? undefined : own(plan, 'content');
        const path = plan === undefined ? undefined : own(plan, 'path');
        const items = type === 'items' && Array.isArray(list);
        const markdown = type === 'markdown' && typeof content === 'string' && (path === undefined || path === null || typeof path === 'string');
        if (plan === undefined || planId === undefined || planId === '' || (!items && !markdown)) {
          return refuse('plan_update that is not an ACP plan update was not sent');
        }
        if (!this.#clientAcceptsPlan && !items) return refuse('plan_update was not sent: the client did not advertise plan updates');
        const idProblem = planIdProblem(planId);
        if (idProblem !== undefined) return refuse(idProblem);
        if (markdown && (longerThan(content as string, PLAN_MARKDOWN_MAX) || (typeof path === 'string' && longerThan(path, PLAN_PATH_MAX)))) {
          return refuse(OVERSIZE_MARKDOWN);
        }
        if (markdown && (MARKDOWN_HIDDEN.test(content as string) || (typeof path === 'string' && holdsHiddenCharacter(path)))) {
          return refuse(HIDDEN_MARKDOWN);
        }
        const checked = items ? checkedPlanEntries(list as unknown[]) : undefined;
        if (typeof checked === 'string') return refuse(checked);
        const planMetaValue = planMeta(own(plan, '_meta'));
        const updateMeta = planMeta(own(update, '_meta'));
        if (!planMetaValue.ok) return refuse(planMetaValue.problem!);
        if (!updateMeta.ok) return refuse(updateMeta.problem!);
        const entries = checked === undefined ? undefined : this.#planEntries(sessionId, checked);
        if (!this.#clientAcceptsPlan) return withMeta({ sessionUpdate: 'plan', entries }, planMetaValue.meta);
        const body = items
          ? { type: 'items', planId, entries }
          : { type: 'markdown', planId, content, ...(typeof path === 'string' ? { path } : {}) };
        return withMeta({ sessionUpdate: 'plan_update', plan: withMeta(body, planMetaValue.meta) }, updateMeta.meta);
      }
      case 'plan_removed': {
        const planId = asString(own(update, 'planId'));
        if (planId === undefined || planId === '') return refuse('plan_removed without a planId was not sent');
        if (!this.#clientAcceptsPlan) return refuse('plan_removed was not sent: the client did not advertise plan updates');
        const removedProblem = planIdProblem(planId);
        if (removedProblem !== undefined) return refuse(removedProblem);
        const meta = planMeta(own(update, '_meta'));
        if (!meta.ok) return refuse(meta.problem!);
        return withMeta({ sessionUpdate: 'plan_removed', planId }, meta.meta);
      }
      default: {
        // Sent as it serializes, read back: the transport calls JSON.stringify, so an own `toJSON`, a getter or a Proxy
        // decides what goes on the wire. The snapshot is what the wire would carry, it must be a plain object of the
        // kind checked above, and it is what is sent -- never the driver's object -- so nothing can turn into a plan
        // after the check. One that cannot be serialized (a BigInt, a throwing toJSON) is refused here too.
        let snapshot: Record<string, unknown> | undefined;
        try {
          const text = JSON.stringify(update);
          snapshot = asObject(typeof text === 'string' ? JSON.parse(text) : undefined);
        } catch {
          return refuse(MALFORMED_SNAPSHOT);
        }
        if (snapshot === undefined || own(snapshot, 'sessionUpdate') !== kind) return refuse(MALFORMED_SNAPSHOT);
        return snapshot as AcpUpdate;
      }
    }
  }

  #planEntries(sessionId: string, entries: readonly CheckedEntry[]): Record<string, unknown>[] {
    let fixed = 0;
    const out = entries.map(({ content, priority, status, _meta }) => {
      const valid = priority !== undefined && PRIORITIES.has(priority);
      if (!valid) fixed += 1;
      return { content, priority: valid ? priority : PLAN_ENTRY_PRIORITY, status, ...(_meta === undefined ? {} : { _meta }) };
    });
    if (fixed === 0) return out;
    this.#reportPlan(sessionId, `${fixed} plan entr${fixed === 1 ? 'y' : 'ies'} had no valid priority and were sent as medium`);
    return out;
  }

  async #sessionPrompt(params: unknown): Promise<Record<string, unknown>> {
    const object = asObject(params);
    const sessionId = asString(object?.sessionId);
    if (sessionId === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, 'session/prompt requires a sessionId');
    }

    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, `no such session: ${sessionId}`);
    }
    if (session.exited) {
      // Distinguishable (`data.code`), so a client retrying a turn whose failure said resumable -- true as of that reply
      // -- knows the agent has gone since, and reloads the session instead of starting a new one.
      throw new RpcError(RPC_INTERNAL_ERROR, `session ${sessionId} has exited`, { code: 'session_exited' });
    }
    if (session.turn !== null) {
      // One turn at a time per session. Interleaving two would mix their
      // updates on one stream with nothing to tell them apart.
      throw new RpcError(RPC_INVALID_PARAMS, `session ${sessionId} already has a turn in flight`);
    }

    const content = this.#promptContent(object?.prompt);

    let refused: PromptRefused | null = null;
    let commandRefused: CommandUnsupported | null = null;
    const outcome = await new Promise<TurnOutcome>((resolve) => {
      session.turn = { settle: resolve, cancelled: false };
      try {
        session.driver.prompt(content);
      } catch (cause) {
        session.turn = null;
        if (cause instanceof PromptRefused) refused = cause;
        if (cause instanceof CommandUnsupported) commandRefused = cause;
        resolve({ stopReason: null, isError: true, raw: messageOf(cause) });
      }
    });
    // A block the driver would not send is the client's request to fix, not a turn that failed.
    if (refused !== null) throw new RpcError(RPC_INVALID_PARAMS, (refused as PromptRefused).message);
    if (commandRefused !== null) throw new RpcError(RPC_INVALID_PARAMS, 'command_unsupported', { code: 'command_unsupported', reason: (commandRefused as CommandUnsupported).reason });
    if (outcome.commandFailure !== undefined) throw new RpcError(RPC_INVALID_PARAMS, 'command_unsupported', outcome.commandFailure);

    // ACP's five stop reasons all describe a turn that FINISHED. None of them
    // describes a crash, so a failed turn is reported as an ERROR rather than
    // given the nearest-looking reason: `end_turn` would claim a clean finish
    // and `refusal` would claim a decision the agent never made.
    if (outcome.stopReason === null) {
      // The reason, when the provider gave one, is structured in `data`: a client deciding whether to hold the turn
      // until a limit resets must not have to parse this message.
      throw new RpcError(
        RPC_INTERNAL_ERROR,
        `turn did not complete${outcome.raw === null ? '' : `: ${outcome.raw}`}`,
        this.#failureData(session, outcome.failure),
      );
    }

    return { stopReason: outcome.stopReason satisfies StopReason };
  }

  /**
   * A failed turn's reason, as the wire carries it (see wireTurnFailure): retryable from the kind, a retry-after only
   * bounded, and never resumable once the session's agent is gone -- checked here, where the session is known, not
   * taken from the driver's word. A driver whose `running` throws counts as not running.
   */
  #failureData(session: Session, failure: unknown): Record<string, unknown> | undefined {
    if (failure === undefined) return undefined;
    let running = !session.exited;
    try {
      if (running && session.driver.running === false) running = false;
    } catch {
      running = false;
    }
    const wire = wireTurnFailure(failure, running);
    return wire === undefined ? undefined : { [META_TURN_FAILURE]: wire };
  }

  /** The prompt block kinds this agent's driver declared; text only when it declared none. */
  #accepts(): readonly PromptBlockKind[] {
    return this.#options.driverCapabilities?.promptBlocks ?? ['text'];
  }

  /**
   * session/prompt's blocks, checked against the driver's declaration. Text blocks alone are joined into the text every
   * driver takes; anything else goes through as blocks. A block the driver does not take refuses the WHOLE prompt,
   * naming it -- it used to be dropped while the rest was sent, so an image beside a sentence vanished without a word.
   */
  #promptContent(prompt: unknown): PromptContent {
    // An empty array is not a prompt. Refusing is better than sending an empty
    // turn the agent will answer with something unrelated.
    if (!Array.isArray(prompt) || prompt.length === 0) {
      throw new RpcError(RPC_INVALID_PARAMS, 'session/prompt requires a prompt of content blocks');
    }
    try {
      const blocks = promptBlocks(prompt, this.#accepts());
      return blocks.every((block) => promptBlockKind(block) === 'text')
        ? blocks.map((block) => (block as { text: string }).text).join('\n')
        : blocks;
    } catch (cause) {
      throw new RpcError(RPC_INVALID_PARAMS, messageOf(cause));
    }
  }

  #sessionCancel(params: unknown): void {
    const sessionId = asString(asObject(params)?.sessionId);
    if (sessionId === undefined) return;
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;

    // Nothing in flight, nothing to stop. Cancel ends a TURN; it used to kill an idle session's agent as well.
    const turn = session.turn;
    if (turn === null || session.exited) return;
    turn.cancelled = true;

    const cancel = session.driver.cancel?.bind(session.driver);
    if (cancel === undefined) {
      this.#stopForCancel(session, turn);
      return;
    }
    // The driver interrupts the turn and the agent ends it; onTurnEnd answers the prompt `cancelled`. The process and
    // the session stay, so the next prompt runs as normal.
    cancel().catch((cause: unknown) => {
      // An interrupt the agent refused must still stop what the client asked to stop: fall back to stopping the
      // agent, as a driver without cancel does.
      this.#options.onProtocolError?.(session.id, `turn cancel failed, stopping the agent: ${messageOf(cause)}`);
      if (session.turn === turn) this.#stopForCancel(session, turn);
    });
  }

  /** Stop a turn by stopping its agent: the only cancel a driver without `cancel()` has. */
  #stopForCancel(session: Session, turn: NonNullable<Session['turn']>): void {
    session.turn = null;
    // `cancelled` is a real ACP stop reason, so a cancelled turn RESOLVES
    // rather than erroring. The client asked for this outcome; it is not a
    // failure.
    turn.settle({ stopReason: 'cancelled', isError: false, raw: 'cancelled' });
    session.driver.kill();
    session.exited = true;
  }
}

/** ACP requires an absolute cwd, and says so with a MUST. */
function requireAbsoluteCwd(params: unknown): string {
  const cwd = asString(asObject(params)?.cwd);
  if (cwd === undefined) {
    throw new RpcError(RPC_INVALID_PARAMS, 'cwd is required and MUST be an absolute path');
  }
  if (!isAbsolute(cwd)) {
    // Enforced rather than resolved against our own cwd. The spec makes cwd the
    // session's filesystem boundary, and silently anchoring a relative path to
    // wherever this process happens to be running would put the agent
    // somewhere the client never named.
    throw new RpcError(RPC_INVALID_PARAMS, `cwd MUST be an absolute path: ${cwd}`);
  }
  return cwd;
}

/** Absolute on either platform, without importing node:path for one check. */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}


function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The driver's model state in ACP's shape: what ACP's model info has no field for rides in `_meta`. */
function acpModels(state: SessionModelState): Record<string, unknown> {
  return {
    availableModels: state.availableModels.map((model) => {
      const extra = {
        ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
        ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
      };
      return {
        modelId: model.modelId,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(Object.keys(extra).length === 0 ? {} : { _meta: { [META_MODEL_INFO]: extra } }),
      };
    }),
    currentModelId: state.currentModelId,
  };
}

function isPermissionOutcome(value: unknown): value is PermissionOutcome {
  const outcome = asObject(value);
  if (outcome?.outcome === 'cancelled') return true;
  return outcome?.outcome === 'selected' && typeof outcome.optionId === 'string';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
