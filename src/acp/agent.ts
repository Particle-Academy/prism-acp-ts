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
 * answer. `loadSession` is reported true only because `session/load` is
 * implemented on top of the CLI's own `--resume`; anything not implemented is
 * reported absent rather than optimistically.
 */
import { JsonRpcPeer, RPC_INVALID_PARAMS, RPC_INTERNAL_ERROR, RpcError } from '../jsonrpc.js';
import type { AcpUpdate } from '../claude/to-acp.js';
import type { StopReason, TurnOutcome } from '../claude/driver.js';
import { META_CLI_SESSION_ID, META_DRIVER_CAPABILITIES, withMeta } from '../meta.js';

/** The protocol version this agent speaks. */
export const PROTOCOL_VERSION = 1;

/** What a driver must offer the agent surface, whichever CLI it drives. */
export interface AgentDriver {
  start(): void;
  prompt(text: string): void;
  endInput(): void;
  kill(signal?: NodeJS.Signals): void;
  readonly cliSessionId: string | null;
  readonly withheldCredentials: readonly string[];
}

export interface DriverEvents {
  readonly onUpdate?: (update: AcpUpdate) => void;
  /** Ask the ACP client to decide a Codex permission request. */
  readonly onRequestPermission?: (
    request: PermissionRequest,
  ) => Promise<PermissionOutcome>;
  readonly onTurnEnd?: (outcome: TurnOutcome) => void;
  readonly onProtocolError?: (problem: string) => void;
  readonly onStderr?: (line: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface PermissionRequest {
  readonly toolCall: Record<string, unknown>;
  readonly options: readonly Record<string, unknown>[];
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export type PermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' };

/**
 * Builds a driver for one session.
 *
 * Injected rather than hardcoded because this surface fronts more than one
 * CLI, including Codex's `app-server`, and because a server
 * that could only be tested by spawning a real agent would have its session
 * bookkeeping covered by nothing.
 */
export type DriverFactory = (
  options: { readonly cwd: string; readonly resumeSessionId?: string },
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
  readonly onProtocolError?: (sessionId: string, problem: string) => void;
}

/** The two provider differences clients currently need to know. */
export interface DriverCapabilities {
  readonly permissionRequests: boolean;
  readonly transcriptReplay: boolean;
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

export class AcpAgent {
  readonly #peer: JsonRpcPeer;
  readonly #options: AcpAgentOptions;
  readonly #sessions = new Map<string, Session>();
  #counter = 0;
  /** Ids this process handed out via session/new. See the refusal in #sessionLoad. */
  readonly #minted = new Set<string>();

  constructor(peer: JsonRpcPeer, options: AcpAgentOptions) {
    this.#peer = peer;
    this.#options = options;

    peer
      .handle('initialize', (params) => this.#initialize(params))
      .handle('authenticate', () => this.#authenticate())
      .handle('session/new', (params) => this.#sessionNew(params))
      .handle('session/load', (params) => this.#sessionLoad(params))
      .handle('session/prompt', async (params) => await this.#sessionPrompt(params));

    peer.onNotify('session/cancel', (params) => this.#sessionCancel(params));
  }

  /** Session ids currently open. */
  get sessionIds(): readonly string[] {
    return [...this.#sessions.keys()];
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

    const response = {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: this.#options.agentInfo ?? {
        name: '@particle-academy/prism-acp',
        title: 'Prism ACP',
        version: '0.1.0',
      },
      // Empty because this agent needs no authentication STEP: the CLI it
      // drives is already authenticated by the user, and no credential ever
      // travels in this protocol. Empty is the honest answer, not a placeholder.
      authMethods: [],
      agentCapabilities: {
        // True, and PROVEN rather than wired. A live test stores a number in
        // one turn, resumes, and asks for it back -- an assertion a fresh
        // conversation cannot satisfy. That test exists because a wrong resume
        // does not error: it starts a new conversation while the caller
        // believes it continued one, so the flag being set proves nothing on
        // its own. A capability reported optimistically is worse than one
        // reported absent, because a client plans around the answer.
        loadSession: true,
        promptCapabilities: {
          // Text only, for now. Reported as false rather than omitted, because
          // for these two the client needs to know we will not accept them.
          image: false,
          audio: false,
          embeddedContext: false,
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
    const id = this.#options.newSessionId?.() ?? `sess_${++this.#counter}_${Date.now()}`;
    this.#minted.add(id);
    this.#open(id, cwd, undefined);
    return { sessionId: id };
  }

  #sessionLoad(params: unknown): Record<string, unknown> {
    const object = asObject(params);
    const cwd = requireAbsoluteCwd(params);
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

    this.#open(sessionId, cwd, sessionId);
    // The spec's result is an empty object; history arrives as session/update
    // notifications. Whether the driver replays transcript history is
    // provider-specific: Claude replays none; Codex replays through its paged
    // App Server endpoints.
    return {};
  }

  #open(id: string, cwd: string, resumeSessionId: string | undefined): Session {
    const session: Session = {
      id,
      cwd,
      driver: undefined as unknown as AgentDriver,
      turn: null,
      exited: false,
    };

    const driver = this.#options.driverFactory(
      { cwd, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) },
      {
        onUpdate: (update) => {
          this.#peer.notify('session/update', { sessionId: id, update });
        },
        onRequestPermission: async (request) => {
          const result = await this.#peer.request('session/request_permission', {
            sessionId: id,
            ...request,
          });
          const outcome = asObject(result)?.outcome;
          return isPermissionOutcome(outcome) ? outcome : { outcome: 'cancelled' };
        },
        onTurnEnd: (outcome) => {
          const turn = session.turn;
          session.turn = null;
          turn?.settle(outcome);
        },
        onStderr: (line) => this.#options.onStderr?.(id, line),
        onProtocolError: (problem) => this.#options.onProtocolError?.(id, problem),
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
      throw new RpcError(RPC_INTERNAL_ERROR, `session ${sessionId} has exited`);
    }
    if (session.turn !== null) {
      // One turn at a time per session. Interleaving two would mix their
      // updates on one stream with nothing to tell them apart.
      throw new RpcError(RPC_INVALID_PARAMS, `session ${sessionId} already has a turn in flight`);
    }

    const text = promptText(object?.prompt);
    if (text === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, 'session/prompt requires a prompt of content blocks');
    }

    const outcome = await new Promise<TurnOutcome>((resolve) => {
      session.turn = { settle: resolve, cancelled: false };
      try {
        session.driver.prompt(text);
      } catch (cause) {
        session.turn = null;
        resolve({ stopReason: null, isError: true, raw: messageOf(cause) });
      }
    });

    // ACP's five stop reasons all describe a turn that FINISHED. None of them
    // describes a crash, so a failed turn is reported as an ERROR rather than
    // given the nearest-looking reason: `end_turn` would claim a clean finish
    // and `refusal` would claim a decision the agent never made.
    if (outcome.stopReason === null) {
      throw new RpcError(
        RPC_INTERNAL_ERROR,
        `turn did not complete${outcome.raw === null ? '' : `: ${outcome.raw}`}`,
      );
    }

    return { stopReason: outcome.stopReason satisfies StopReason };
  }

  #sessionCancel(params: unknown): void {
    const sessionId = asString(asObject(params)?.sessionId);
    if (sessionId === undefined) return;
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;

    if (session.turn !== null) {
      session.turn.cancelled = true;
      const turn = session.turn;
      session.turn = null;
      // `cancelled` is a real ACP stop reason, so a cancelled turn RESOLVES
      // rather than erroring. The client asked for this outcome; it is not a
      // failure.
      turn.settle({ stopReason: 'cancelled', isError: false, raw: 'cancelled' });
    }

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

/** Flatten ACP content blocks into the text a CLI prompt wants. */
function promptText(prompt: unknown): string | undefined {
  if (!Array.isArray(prompt)) return undefined;
  const parts: string[] = [];
  for (const block of prompt) {
    const object = asObject(block);
    if (object?.type === 'text' && typeof object.text === 'string') parts.push(object.text);
  }
  // An empty array is not a prompt, and neither is an array of blocks we cannot
  // render. Refusing is better than sending an empty turn the agent will answer
  // with something unrelated.
  return parts.length === 0 ? undefined : parts.join('\n');
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isPermissionOutcome(value: unknown): value is PermissionOutcome {
  const outcome = asObject(value);
  if (outcome?.outcome === 'cancelled') return true;
  return outcome?.outcome === 'selected' && typeof outcome.optionId === 'string';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
