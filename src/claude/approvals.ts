import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PermissionOutcome, PermissionRequest } from '../acp/agent.js';

/**
 * PERMISSION PROMPTS FOR CLAUDE (issue #1): a person approves a tool call before it runs, as CodexDriver already
 * allows. Claude Code's documented route in `-p` mode is a PreToolUse command hook; this module supplies one for a
 * single invocation (`--settings`), a private socket the hook hands each call to, and the mapping both ways.
 *
 * Measured 2026-10-13 on claude-code 2.1.296: a `--settings` PreToolUse hook fires in `-p`; it receives
 * `{ session_id, tool_name, tool_input, tool_use_id, cwd, permission_mode, ... }`; its `deny` stopped a Bash call with
 * the reason passed to the model; an `allow` returned after a 20 s wait let the call run.
 *
 * FAILS CLOSED. Only an explicit "allow once" from the client allows. A cancelled request, an unknown option, no
 * handler, a wrong token, no server, a malformed answer: deny (or exit 2, which blocks). The hook is also marked
 * `onFailure: "block"` so Claude itself treats a hook failure or timeout as a block, not a pass.
 */

/** The hook's input, as Claude Code sends it (the fields this package reads). */
export interface HookInput {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_use_id?: unknown;
  readonly [key: string]: unknown;
}

export interface HookDecision {
  readonly hookEventName: 'PreToolUse';
  readonly permissionDecision: 'allow' | 'deny';
  readonly permissionDecisionReason: string;
}

/** How long a call may wait for a person, in seconds: a person may be away. */
export const APPROVAL_WAIT_SECONDS = 86_400;

/** A tool name that could widen the hook's matcher (a regex) is refused. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The `--settings` for this invocation: one PreToolUse command hook for the named tools. The command is the running
 * node binary on the written hook script, both quoted (paths with spaces on Windows).
 */
export function approvalSettings(nodePath: string, hookPath: string, tools: readonly string[]): Record<string, unknown> {
  if (tools.length === 0) throw new Error('permission prompts need at least one tool name');
  for (const t of tools) if (!TOOL_NAME.test(t)) throw new Error(`refusing tool name ${JSON.stringify(t)}: a tool name is a single identifier`);
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: tools.join('|'),
          hooks: [{ type: 'command', command: `"${nodePath}" "${hookPath}"`, timeout: APPROVAL_WAIT_SECONDS, onFailure: 'block' }],
        },
      ],
    },
  };
}

/** The request a client sees: the same shape CodexDriver raises, with Allow once and Deny. */
export function permissionRequestFor(input: HookInput): PermissionRequest {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'Tool';
  const args = typeof input.tool_input === 'object' && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
  const summary = typeof args.command === 'string' ? args.command
    : typeof args.file_path === 'string' ? args.file_path
    : typeof args.url === 'string' ? args.url
    : typeof args.description === 'string' ? args.description
    : '';
  return {
    toolCall: {
      toolCallId: typeof input.tool_use_id === 'string' ? input.tool_use_id : `claude-permission-${randomBytes(4).toString('hex')}`,
      title: summary ? `${tool}: ${summary}` : tool,
      rawInput: input.tool_input ?? null,
    },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ],
  };
}

/** The hook's answer: allow ONLY for an explicit "allow once". */
export function decisionFor(outcome: PermissionOutcome): HookDecision {
  const given = typeof outcome.reason === 'string' && outcome.reason !== '' ? outcome.reason : undefined;
  if (outcome.outcome === 'selected' && outcome.optionId === 'allow_once') {
    // An allow the client made itself (nobody was asked) says so when it gives a reason.
    return { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: given ?? 'Allowed by the person.' };
  }
  const fallback = outcome.outcome === 'cancelled' ? 'The request was cancelled.' : 'The person denied this tool call.';
  // The client's own reason when it gave one (a limit it enforces is not the person's refusal); today's text otherwise.
  const why = given ?? fallback;
  return { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why };
}

/**
 * The hook script Claude runs (CommonJS, no dependencies): its stdin is the hook input; it POSTs it to the driver over
 * the private socket named in `PRISM_ACP_APPROVAL_SOCKET` with the bearer in `PRISM_ACP_APPROVAL_TOKEN`, prints the
 * driver's answer, and EXITS 2 (block) on anything else.
 */
export const HOOK_SCRIPT = `'use strict';
const http = require('http');
const block = (why) => { process.stderr.write('prism-acp: ' + why + '\\n'); process.exit(2); };
const socketPath = process.env.PRISM_ACP_APPROVAL_SOCKET;
const token = process.env.PRISM_ACP_APPROVAL_TOKEN;
if (!socketPath || !token) block('no approval channel; the tool call is blocked');
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { body += d; });
process.stdin.on('end', () => {
  const req = http.request({ socketPath, path: '/approve', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'content-length': Buffer.byteLength(body) } }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { out += d; });
    res.on('end', () => {
      if (res.statusCode !== 200) block('the approval channel refused (' + res.statusCode + '); the tool call is blocked');
      try {
        const parsed = JSON.parse(out);
        const d = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision;
        if (d !== 'allow' && d !== 'deny') block('unreadable answer; the tool call is blocked');
        process.stdout.write(JSON.stringify(parsed));
        process.exit(0);
      } catch (e) { block('unreadable answer; the tool call is blocked'); }
    });
  });
  req.on('error', () => block('the approval channel is unreachable; the tool call is blocked'));
  req.end(body);
});
`;

/**
 * The driver's end of the channel: an HTTP server on a private socket (a named pipe on Windows), bound before Claude
 * starts, answering `POST /approve` with the client's decision. A request without the token is refused 401.
 */
export class ApprovalServer {
  readonly #socket: string;
  readonly #ask: (input: HookInput) => Promise<PermissionOutcome>;
  readonly #token = randomBytes(32).toString('hex');
  #server: Server | null = null;

  constructor(socket: string, ask: (input: HookInput) => Promise<PermissionOutcome>) {
    this.#socket = socket;
    this.#ask = ask;
  }

  /** Bind the socket (synchronously, so it exists before the CLI is spawned) and return what the hook needs. */
  listen(): { socket: string; token: string } {
    const server = createServer((req, res) => { void this.#handle(req, res); });
    server.listen(this.#socket);
    this.#server = server;
    return { socket: this.#socket, token: this.#token };
  }

  close(): void {
    this.#server?.close();
    this.#server = null;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const presented = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from(`Bearer ${this.#token}`);
    if (req.method !== 'POST' || req.url !== '/approve' || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      send(401);
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let input: HookInput;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      input = parsed as HookInput;
    } catch {
      send(400);
      return;
    }
    let outcome: PermissionOutcome;
    try {
      outcome = await this.#ask(input);
    } catch {
      outcome = { outcome: 'cancelled' };
    }
    send(200, { hookSpecificOutput: decisionFor(outcome) });
  }
}
