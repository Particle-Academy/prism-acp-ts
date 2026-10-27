import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { windowsCommandLine } from '../process-tree.js';
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
 * Claude2.1.310 was also measured against a loopback model: onFailure:block blocks crashes/timeouts, but empty or
 * plain-text exit0 (including malformed JSON) still permits a tool. The command guard therefore maps ONLY the
 * script's explicit-allow exit42 to0; all other exits become blocking2. The script validates the channel answer
 * before issuing42. onFailure:block remains necessary when the guard itself cannot start or times out.
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
const EXPLICIT_ALLOW = 42;

/** onFailure:block was introduced in2.1.295;2.1.310 is the native regression pin. Reject opaque/prerelease versions. */
export function approvalCliVersion(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  if (parts.some(p => !Number.isSafeInteger(p))) return null;
  const [major, minor, patch] = parts;
  return major! > 2 || (major === 2 && (minor! > 1 || (minor === 1 && patch! >= 295))) ? value : null;
}

export function approvalWaitSeconds(value = APPROVAL_WAIT_SECONDS): number {
  if (!Number.isInteger(value) || value < 1 || value > APPROVAL_WAIT_SECONDS) {
    throw new Error('permission prompt timeoutSeconds must be an integer from 1 to 86400');
  }
  return value;
}

/** A tool name that could widen the hook's matcher (a regex) is refused. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Exec-form hook: Claude passes an argv vector, with no shell tokenization. Its exit adapter uses the platform's
 * existing interpreter (Windows PowerShell or POSIX /bin/sh). Paths are argv/data, never shell source. The Electron
 * flag belongs only to the hook runtime and is removed before the worker starts. Provider environments are unchanged.
 */
export function approvalSettings(nodePath: string, hookPath: string, tools: readonly string[], options: {
  readonly electron?: boolean;
  readonly timeoutSeconds?: number;
} = {}): Record<string, unknown> {
  if (tools.length === 0) throw new Error('permission prompts need at least one tool name');
  for (const t of tools) if (!TOOL_NAME.test(t)) throw new Error(`refusing tool name ${JSON.stringify(t)}: a tool name is a single identifier`);
  for (const path of [nodePath, hookPath]) if (!path || /[\0\r\n]/.test(path)) throw new Error('permission hook paths must be nonempty single-line paths');
  const windows = process.platform === 'win32';
  // Use inherited byte streams on Windows; a PowerShell output pipeline would decode/re-encode the JSON.
  const config = Buffer.from(JSON.stringify({ node: nodePath, arguments: windowsCommandLine([hookPath]), electron: options.electron === true }), 'utf8').toString('base64');
  const powershell = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $config.node
  $info.Arguments = $config.arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardError = $true
  if ($config.electron) { $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' }
  $child = [Diagnostics.Process]::Start($info)
  $child.BeginErrorReadLine()
  $child.WaitForExit()
  if ($child.ExitCode -eq ${EXPLICIT_ALLOW}) { exit 0 }
} catch {}
[Console]::Error.Write('prism-acp: approval hook failed or denied; tool call blocked' + [char]10)
exit 2`;
  const command = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')]
    : ['-c', `${options.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}"$1" "$2" 2>/dev/null; code=$?; if [ "$code" -eq ${EXPLICIT_ALLOW} ]; then exit 0; fi; printf '%s\\n' 'prism-acp: approval hook failed or denied; tool call blocked' >&2; exit 2`, 'prism-acp-approval', nodePath, hookPath];
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: tools.join('|'),
          hooks: [{ type: 'command', command, args, timeout: approvalWaitSeconds(options.timeoutSeconds) + 5, onFailure: 'block' }],
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
  if (typeof outcome !== 'object' || outcome === null) return { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No valid approval was received.' };
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
 * driver's validated decision. Exit42 means an explicit allow, for the command guard ONLY; never install this script
 * as an unguarded hook. Every other completion is deny/exit2. The internal deadline expires before Claude's timeout,
 * so a stalled channel produces a denial rather than relying on native timeout behavior alone.
 */
export function approvalHookScript(timeoutSeconds = APPROVAL_WAIT_SECONDS): string {
  const wait = approvalWaitSeconds(timeoutSeconds);
  return `'use strict';
// This flag is for this executable only; neither a worker nor a later child inherits it.
delete process.env.ELECTRON_RUN_AS_NODE;
const { Worker, isMainThread } = require('worker_threads');
if (isMainThread) {
  const fs = require('fs');
  let complete = false;
  let stdout = Buffer.alloc(0);
  const writeAnswer = (bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(1, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('approval output was not written');
      offset += written;
    }
  };
  const fail = () => finish(null);
  const finish = (bytes, allow = false) => {
    if (complete) return;
    complete = true;
    clearTimeout(timer);
    if (bytes !== null) { try { writeAnswer(bytes); } catch { process.exit(2); } }
    else {
      try { fs.writeSync(1, JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'No valid approval was received; the tool call is blocked.'}}) + '\\n'); } catch {}
    }
    if (!allow) { try { fs.writeSync(2, 'prism-acp: approval hook failed or denied; tool call blocked\\n'); } catch {} }
    process.exit(allow ? ${EXPLICIT_ALLOW} : 2);
  };
  const timer = setTimeout(fail, ${wait * 1000 + 1000});
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  const worker = new Worker(__filename, { stdin: true, stdout: true, stderr: true, env: { ...process.env } });
  worker.on('error', fail);
  worker.stdin.on('error', fail);
  process.stdin.on('error', fail);
  process.stdin.pipe(worker.stdin);
  worker.stderr.resume();
  worker.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > 1000000) fail();
  });
  worker.on('exit', (code) => {
    try {
      const parsed = JSON.parse(stdout.toString('utf8'));
      const answer = parsed && parsed.hookSpecificOutput;
      const canonical = Buffer.from(JSON.stringify(parsed) + '\\n');
      if (!answer || Object.keys(parsed).length !== 1 || Object.keys(answer).length !== 3 || answer.hookEventName !== 'PreToolUse' || typeof answer.permissionDecisionReason !== 'string' || !canonical.equals(stdout)) { fail(); return; }
      if (code === ${EXPLICIT_ALLOW} && answer.permissionDecision === 'allow') { finish(stdout, true); return; }
      // Preserve a valid client's denial JSON, but never expose worker error text or unvalidated stdout.
      if (code === 2 && answer.permissionDecision === 'deny') { finish(stdout); return; }
    } catch {}
    fail();
  });
} else {
const http = require('http');
let finished = false;
let deadline;
const finish = (decision, why) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: why } };
  // Worker stdout is a message-backed stream, not fd1 (which would bypass the guard). Flush before exiting.
  process.stdout.write(JSON.stringify(output) + '\\n', (error) => process.exit(error ? 2 : decision === 'allow' ? ${EXPLICIT_ALLOW} : 2));
};
const block = (why) => finish('deny', why);
process.on('uncaughtException', () => block('approval hook failed; the tool call is blocked'));
process.on('unhandledRejection', () => block('approval hook failed; the tool call is blocked'));
process.on('exit', () => {
  if (!finished) {
    process.exitCode = 2;
  }
});
deadline = setTimeout(() => block('approval timed out; the tool call is blocked'), ${wait * 1000});
const socketPath = process.env.PRISM_ACP_APPROVAL_SOCKET;
const token = process.env.PRISM_ACP_APPROVAL_TOKEN;
if (!socketPath || !token) { block('no approval channel; the tool call is blocked'); return; }
const input = [];
let inputBytes = 0;
process.stdin.on('error', () => block('unreadable hook input; the tool call is blocked'));
process.stdin.on('data', (d) => { inputBytes += d.length; if (inputBytes > 1000000) { block('hook input is too large; the tool call is blocked'); return; } input.push(d); });
process.stdin.on('end', () => {
  const bytes = Buffer.concat(input);
  const body = bytes.toString('utf8');
  try {
    if (!Buffer.from(body).equals(bytes)) throw new Error();
    const input = JSON.parse(body);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  } catch { block('unreadable hook input; the tool call is blocked'); return; }
  const req = http.request({ socketPath, path: '/approve', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'content-length': Buffer.byteLength(body) } }, (res) => {
    const chunks = [];
    let answerBytes = 0;
    res.on('error', () => block('approval response failed; the tool call is blocked'));
    res.on('aborted', () => block('approval response was interrupted; the tool call is blocked'));
    res.on('close', () => { if (!res.complete) block('approval response was interrupted; the tool call is blocked'); });
    res.on('data', (d) => { answerBytes += d.length; if (answerBytes > 1000000) { block('approval answer is too large; the tool call is blocked'); return; } chunks.push(d); });
    res.on('end', () => {
      if (res.statusCode !== 200) { block('the approval channel refused (' + res.statusCode + '); the tool call is blocked'); return; }
      try {
        const bytes = Buffer.concat(chunks);
        const out = bytes.toString('utf8');
        if (!Buffer.from(out).equals(bytes)) throw new Error();
        const parsed = JSON.parse(out);
        const answer = parsed && parsed.hookSpecificOutput;
        if (!answer || answer.hookEventName !== 'PreToolUse' || (answer.permissionDecision !== 'allow' && answer.permissionDecision !== 'deny') || typeof answer.permissionDecisionReason !== 'string') {
          block('unreadable answer; the tool call is blocked'); return;
        }
        // Reconstruct only our decision; never forward other hook fields (updatedInput, continue, ...).
        finish(answer.permissionDecision, answer.permissionDecisionReason);
      } catch (e) { block('unreadable answer; the tool call is blocked'); }
    });
  });
  req.on('error', () => block('the approval channel is unreachable; the tool call is blocked'));
  req.end(body);
});
}
`;
}

export const HOOK_SCRIPT = approvalHookScript();

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
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.listen(this.#socket);
    this.#server = server;
    return { socket: this.#socket, token: this.#token };
  }

  close(): void {
    this.#server?.closeAllConnections();
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
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += bytes.length;
      if (size > 1_000_000) { send(413); return; }
      chunks.push(bytes);
    }
    let input: HookInput;
    try {
      const bytes = Buffer.concat(chunks);
      const raw = bytes.toString('utf8');
      if (!Buffer.from(raw).equals(bytes)) throw new Error('invalid UTF-8');
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
