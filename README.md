# prism-acp (TypeScript)

Speak the [Agent Client Protocol](https://agentclientprotocol.com) to a
coding-agent CLI **the user has already authenticated**.

A client — an editor, a terminal UI, an orchestrator — gets structured state
from an agent instead of guessing it from bytes on a pseudo-terminal: session
state, streaming assistant output with thought content separable, tool calls
with status, a plan that changes in place, token usage and cost. Codex can raise
mid-turn permission requests for the client to answer; Claude currently cannot,
though Claude tool denials are reported as failed tool calls.

```sh
npm install @particle-academy/prism-acp
```

**Zero runtime dependencies.** It drives the agent CLI already on the machine,
so the user's existing subscription login is the authentication — there is no
API key to supply and no adapter program to install.

## Status

Early, but a client can talk to it. `initialize`, `session/new`,
`session/load`, `session/prompt` and `session/cancel` work over a pipe. Claude
and Codex have both been proven end to end against authenticated binaries:
Claude through `stream-json`, and Codex through `codex app-server`. The opt-in
Codex real-child test completes an ACP turn and verifies that `OPENAI_API_KEY`
is absent from the spawned child's environment.

Missing: `session/set_mode` and the client-side `fs/*` and `terminal/*` calls an
agent can make back. The surface will change.

| piece | state |
|---|---|
| NDJSON framing | built |
| child-environment construction | built |
| JSON-RPC peer | built |
| extension-field policy (`_meta`) | built |
| Claude `stream-json` → ACP mapping | built |
| Claude process driver | built |
| ACP server surface + stdio | built |
| `session/load` resume | built, and **proven** to remember the first turn |
| `session/set_mode`, `fs/*`, `terminal/*` | not yet |
| Codex App Server driver | built; real-child turn, paged history and permission requests |

**It maps 7 of ACP's 19 `session/update` kinds**, and that number is asserted by
a test rather than described here, so raising it means moving it. The twelve it
does not map each carry a measured reason — most notably the three plan kinds:
the CLI emits **no plan frame at all**. A captured turn that built a three-item
plan produced it entirely as `TaskCreate` / `TaskUpdate` tool calls, so ACP's
plan kinds could only ever be *synthesised* here, and that is a decision to take
deliberately rather than a mapping to add casually. Until then a plan is not
lost — it is visible as the tool calls that built it.

## Why drive a CLI rather than call an API

Because of the authentication, and it is the whole reason this package exists.

A provider **API** client needs an API key and bills per token. A user who pays
for a subscription already has working credentials — in the CLI's own store, not
in any protocol — and the way to use them is to run the CLI they belong to. So
this package spawns the agent binary and translates, rather than reimplementing
the agent against an HTTP API the user has no key for.

That also keeps the credential out of this package entirely. It never reads one,
never holds one, and never puts one on a wire.

## The environment is built, not inherited

`childEnv` constructs the spawned CLI's environment **allow-list-first**, and
withholds credentials that would outrank the CLI's own login:

```ts
import { childEnv } from '@particle-academy/prism-acp';

const { env, withheld } = childEnv(process.env);
// withheld: ['ANTHROPIC_API_KEY']  -- names only; values are never read
```

This matters more than it looks. The SDK behind these CLIs resolves credentials
from an **ordered** list, and `ANTHROPIC_API_KEY` is first — so an inherited key
does not lose to the subscription, it **outranks** it:

- a **valid** inherited key bills per token while the interface reports a
  subscription session;
- an **invalid** one makes every call fail `401 authentication_failed` and retry
  to exhaustion. It does **not** fall back to the working login, because
  precedence is resolved before validity is tested — so the 401 points at the
  account, one layer below the actual cause.

An allow-list rather than a deny-list, deliberately: a deny-list naming today's
credential variables is one new provider variable away from being wrong again,
in the direction that spends money silently. Names are compared
case-insensitively, because Windows environment names are case-insensitive and
`anthropic_api_key` reaches a child exactly as the uppercase spelling does.

The allow-list withholds every variable not named in it, credentials and
non-credentials alike. If the child needs an orchestrator session or terminal
id, a callback URL, or a feature flag, name it in `allowEnv` or it will not
arrive. This failure is silent: the child can start and appear healthy while
being unable to identify itself, rather than reporting a missing variable.
An allowed variable whose parent value is `''` is forwarded as an empty string.
That can be worse than omitting it: a referenced-but-unset value in an MCP
config can stop every server in that file. When there is no value to give,
omit the variable instead of passing its name with a blank value. `childEnv`
does not filter blanks for you, because an intentionally empty value can be
meaningful for some variable names and the package will not guess which.

Nothing here mutates `process.env`. A workspace may hold an API key on purpose —
other consumers beside this one legitimately bill per token — so the child's
environment is constructed and the ambient one is left alone.

## Framing is pinned, not inferred

This package exists in three languages, and framing is where three
implementations of one protocol disagree without anyone noticing. So:

- a trailing `\r` is **stripped**, not left to each language's JSON parser to
  tolerate;
- `MAX_LINE_BYTES` is **1,000,000** in every port, because a cap that differs
  per language means one implementation dies where another succeeds on the same
  stream;
- an oversized or unparseable line reports its **size, never its content** — a
  line here can carry a prompt, a file or a credential, and a framing error is
  not a reason to copy it into a log.

## Asking a person before Claude runs a tool

CodexDriver raises `onRequestPermission` when Codex wants approval. ClaudeDriver does too, for the tools you name:

```ts
new ClaudeDriver({ cwd, permissionPrompts: { tools: ['Bash', 'WebFetch'] } }, {
  onRequestPermission: async (request) => askThePerson(request), // { outcome: 'selected', optionId: 'allow_once' } runs it
});
```

Each matching call waits for the answer: **Allow once** runs it, anything else (Deny, a cancel, an unknown option, no
handler) denies it, and the denial reason reaches the model. It is a PreToolUse command hook supplied for this one
invocation with `--settings`, talking to the driver over a private socket with a token that travels only in the
environment; the hook is marked `onFailure: "block"`, so a broken channel blocks the call rather than passing it.

A decision that is not the person's -- a limit your client enforces, or an allow it made without asking -- can carry
its own reason, which the agent reads instead of "The person denied this tool call." or "Allowed by the person.":
return `{ outcome: 'selected', optionId: 'reject_once', reason }` (over ACP, put it in the response's
`_meta["particle.academy/permission_reason"]`). It never changes the decision. Claude always receives it; Codex only on
a refusal through its legacy approval methods, since its allows and its v2 decisions carry no text.

## Choosing the model, and learning which one you got

Both drivers take a `model` option: Claude Code's `--model` (an alias such as `sonnet` or a full id), and the
Codex App Server's `model` on `thread/start` / `thread/resume`. Omitted, each uses its own default. A model that is empty
or starts with `-` is refused before it reaches the provider.

The model **in use** is reported as the provider names it, on a notice:

```ts
import { META_MODEL } from '@particle-academy/prism-acp';

const model = update._meta?.[META_MODEL]; // e.g. 'claude-haiku-5-5', 'gpt-6.1-sol'
```

Claude reports it on its first frame; Codex on the thread's start or resume, and again on `model/rerouted` when it
switches. A provider that does not name its model carries no key -- never a guessed default.

### The models the account offers, and switching

The list comes from the provider, for the account that is signed in, so a new model appears without anyone editing a
list: Claude's control `initialize` answer (what the Agent SDK's `supportedModels()` reads) and Codex's `model/list`.
No turn runs to get it.

```ts
import { listModels } from '@particle-academy/prism-acp';

// Before any session exists, e.g. to fill a picker. Starts the CLI briefly and ends it.
const { availableModels, currentModelId } = await listModels('claude');
// [{ modelId: 'fable', name: 'Fable 5.1', description: '...', resolvedModel: 'claude-fable-5-1' }, ...]

// On a running session:
const state = await driver.modelState();   // the same shape; currentModelId is this session's model
await driver.setModel('fable');            // Claude: switched at once. Codex: from the next turn on.
```

Over ACP, `session/new` and `session/load` carry the same list as ACP's (unstable) session model state,
`models: { availableModels: [{ modelId, name, description }], currentModelId }`, with `resolvedModel` and `isDefault`
under `_meta["particle.academy/model_info"]`; and `session/set_model` switches a live session. If the provider does not
answer within 10 s, `models` is left out, never invented. The request shapes are measured: re-run
`npm run probe:claude-models` and `npm run probe:codex-models` when a CLI changes.

## Resuming a session: use the CLI's id, not ACP's

`session/load` works, and `initialize` reports `loadSession: true`. The trap is
which id to pass.

**ACP's `sessionId` is not resumable.** `session/new` returns an id this server
minted; providers resume with their own session identity. Claude accepts its
CLI session id (a UUID or session title) through `claude --resume`; Codex uses
its App Server thread id. The provider's id is published on the **first**
`session/update` of every session:

```ts
import { META_CLI_SESSION_ID } from '@particle-academy/prism-acp';

// on the first session/update of a session
const cliSessionId = update._meta?.[META_CLI_SESSION_ID];
// store this against your own record -- it is what survives a restart
```

Then after a crash, a kill, or a restart:

```
session/load { sessionId: <the cli session id>, cwd: <absolute> }
```

Pass the ACP id instead and you get an error naming the key above, rather than a
success followed by a dead first prompt. That refusal exists because the CLI's
own complaint arrives one turn too late: it does error on an id it cannot
resume -- verified against claude 2.1.292 for both a non-UUID and a well-formed
UUID that does not exist, and it never silently starts a fresh conversation --
but by then `session/load` has already returned `{}` and you believe you have a
resumed session.

A session whose agent has **exited** is loadable; one whose agent is **still
running** is refused, by either id.

History on load depends on the provider. **Claude replays none**: its CLI emits
no transcript on resume, so returning `{}` with no `session/update` is the
honest report. **Codex does replay history**: the driver resumes with
`excludeTurns: true`, then fetches turns and items through the paged App Server
methods and sends them as ACP updates. This deliberately differs between the
drivers because their measured resume behavior differs. Codex thread ids are
the provider's own captured ids and are the same ids accepted by its resume
method; ACP-minted ids are refused.

The human half of the conversation differs too. Against a real Claude child,
the CLI did not echo the client's prompt as `user_message_chunk`, and loading
its session replayed zero updates. A Claude client cannot reconstruct the whole
conversation from ACP alone; record the human turn yourself. Codex's mapping
does emit text from `userMessage` items as `user_message_chunk` during history
replay, so a Codex `session/load` will carry that human text. Measured against a
real Codex child, a live turn reports the user's text as one
`user_message_chunk`. Releases 0.5.2 and earlier emitted it twice because our
mapper handled both `item/started` and `item/completed`; client-side
deduplication added for that behavior is no longer needed. Record the human
turn yourself for both providers, and treat a live `user_message_chunk` as the
agent's record of what it received, not as new input to append again.

### Refusing an unknown id at load, not a turn later

Pass `probeSession` and an id naming **no** conversation is refused by
`session/load` itself, instead of starting an agent that fails on its first
prompt:

```ts
import { probeSessionStore } from '@particle-academy/prism-acp';

const probeSession = (sessionId: string) => probeSessionStore(sessionId);
```

Pass that to `serve` beside `driverFactory` — see [Using it](#using-it).

It costs a directory listing, not a turn. The obvious probe -- resuming with a
throwaway prompt -- refuses a bad id for free but **answers** a good one, so it
would spend a real turn on every successful load.

**It can decline to answer, and that matters more than the refusal.** The result
is `present`, `absent` or `indeterminate`, and only `absent` refuses. The store's
layout is undocumented, so a store the probe cannot read -- a relocated home, a
permissions problem, a future CLI version -- reports `indeterminate` and the load
proceeds exactly as it did before. Calling a real session absent would refuse a
resume that would have worked, which is worse than the late error this replaces;
that error is still there as the backstop.

**It looks where the CLI looks, including `CLAUDE_CONFIG_DIR`.** The CLI resolves
its configuration home as that variable or, unset, `<home>/.claude`, and keeps
`projects` under whichever it picked — so the probe does the same. This is not a
detail: an installation that sets it does so because the stored subscription
credential lives there, which is exactly the installation whose resumes matter,
and reading the wrong store would report a real conversation `absent` and refuse
a resume that would have worked.

`childEnv` passes that variable through unchanged, so a driver spawned from this
process resolves the same store the probe read, by construction. Hand the driver
a `parentEnv` you built yourself and hand the same environment to the probe, or
name the store outright:

```ts
const probeSession = (sessionId: string) => probeSessionStore(sessionId, { env: parentEnv });
```

`probeSession` is yours to supply because the answer belongs to the agent being
driven, not to ACP: `probeSessionStore` reads Claude's session store. Codex
checks its identity by resuming the captured id through `thread/resume`; omit
`probeSession` when using Codex.

## Codex permissions

`CodexDriver` accepts two trusted configuration options, sent on both `thread/start` and `thread/resume`:

- `approvalPolicy`: `'untrusted' | 'on-request' | 'never'`. New threads default to `'on-request'`. On resume,
  it is sent only when explicitly configured, preserving Codex's existing setting when omitted.
- `sandbox`: `'read-only' | 'workspace-write' | 'danger-full-access'`. Omitted leaves the choice to Codex's own
  default or resumed setting; no sandbox override is sent.

Unknown values are refused at construction, before anything is spawned or sent. In particular, `'on-failure'` is
not supported: these are the string values in Codex App Server's schema (`codex-cli 0.163.0`, regenerated with
`codex app-server generate-json-schema`). Never derive either option from model or tool output.

For a caller that deliberately wants full access ("yolo mode"):

```ts
new CodexDriver({ cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
```

**`'never'` + `'danger-full-access'` turns off Codex's approval prompts AND its sandbox: commands run with the
user's full permissions and nobody is asked.**

Codex App Server approvals become ACP `session/request_permission` requests.
The driver offers the decisions Codex sent, including the persistent
execpolicy-amendment choice; its argv is kept on that option under
`particle.academy/execpolicy_amendment` so a client can preserve the distinction
between one-time approval and a remembered command. Human decisions have no
default timeout. Cancelling a session, disconnecting the ACP client, or shutting
down the driver answers any outstanding Codex approval with `cancel`.

Claude permission denials arrive as `tool_call_update` with `status: "failed"`
and the sanitized rejection message in `content`. The structured refusal detail
is in `_meta` under `particle.academy/permission_denied`, allowing a client to
distinguish a refusal from a crash. If provider text contained terminal control
sequences, `providerTextSanitized: true` records that fact without forwarding
the removed bytes. If the CLI omits its message, the update omits `content`.

## Rate limits are a gauge, not just a breach event

ACP has no field for a rate limit, so the detail rides in `_meta` under
`particle.academy/rate_limit` alongside a human-readable notice. It is a
**declared type**, not a passthrough:

```ts
import { parseRateLimit, type ClaudeRateLimit } from '@particle-academy/prism-acp';

const limit: ClaudeRateLimit | undefined = parseRateLimit(payload);
const fiveHour = limit?.windows.five_hour;

if (fiveHour !== undefined) {
  const remaining = Math.max(0, 1 - fiveHour.utilization);
  console.log(`${Math.round(remaining * 100)}% left, resets ${new Date(fiveHour.resetsAtMs)}`);
}
```

The frame arrives **mid-turn with `status: "allowed"`**, not only once you are
limited, and `utilization` moves as work is done — so remaining headroom is a
real reading rather than a feature invented to fill a panel.

Three things a consumer needs and cannot infer:

- **`resetsAt` is epoch SECONDS on the wire.** `resetsAtMs` is this package's,
  converted once. Read the provider's field as milliseconds and every reset
  time lands in January 1970.
- **`utilization` can exceed 1.** The frame models overage, so a window past
  its allowance is a real state; the parse does not cap it, because a capped
  figure would be one this package made up. Clamp where you draw the bar, next
  to `isUsingOverage`.
- **`status` and `overageStatus` are open string unions.** Every frame captured
  says `"allowed"`; no breached frame has ever been captured, so the breached
  spelling is unknown. Test `status !== 'allowed'`, and never match a specific
  breach value.

`parseRateLimit` returns `undefined` rather than a partial, and a payload it
does not recognise gets **no `rate_limit` key at all** — the frame goes to
`particle.academy/unmapped_frame` instead, **with the field that failed named**:

```
rate_limit: unifiedWindows.five_hour.utilization expected finite number >= 0, got null
```

That reason is load-bearing precisely because the refusal is total: one bad
field rejects the whole payload, so this string is the only thing a human gets.
Generic would mean a bug report of "the gauge vanished" rather than "they
renamed `utilization`". `readRateLimit()` returns it to you directly
(`{ ok: true, limit } | { ok: false, reason }`) if you would rather handle the
refusal than check for `undefined`.

A string value is described as `string(10)`, never quoted. This mapper sits on
the same stream as prompts, file contents and credentials, and the type tells
you a number became a string just as well as the digits would. That is the whole reason it is a
parse and not an interface: an interface over `unknown` is a cast, so a renamed
provider field would still read as `undefined`, and a gauge renders `undefined`
as empty. An empty headroom gauge is read by a human as plenty of headroom.

Codex has a separate `CodexRateLimit` parser because App Server windows report
`usedPercent` and `windowDurationMins`; Claude's
`ClaudeRateLimit` uses fractional `utilization` and named windows. Both convert
the provider's epoch-second reset timestamp to `resetsAtMs`. Do not feed one
provider's payload to the other's parser.

Both parsers accept usage beyond the allowance (`usedPercent` above 100 or
`utilization` above 1) without capping it. Overage is real state, and capping
would invent a reading; clamp only the rendered bar, not the reported value.

## Using it

```ts
import { serve, ClaudeDriver, CLAUDE_DRIVER_CAPABILITIES } from '@particle-academy/prism-acp';

serve({
  input: process.stdin,
  output: process.stdout,
  driverFactory: (options, events) => new ClaudeDriver(options, events),
  driverCapabilities: CLAUDE_DRIVER_CAPABILITIES,
  probeSession,
});
```

A client then speaks ACP on those pipes. Several sessions run at once, each with
its own agent process, its own in-flight turn and its own updates — tagged with
the session they belong to, because a room of agents shares one stream.

`session/new` and `session/load` forward the client's `mcpServers` to the
provider. Pass the factory's options through to the driver as above. Claude
supports stdio, HTTP and SSE; Codex supports stdio and HTTP and refuses SSE.
Use `CODEX_DRIVER_CAPABILITIES` with `CodexDriver` to advertise its support.
The declaration publishes `mcpCapabilities` in ACP's `agentCapabilities`.

For example, a session request can include:

```json
{
  "cwd": "/work/project",
  "mcpServers": [{
    "type": "http",
    "name": "workspace",
    "url": "http://127.0.0.1:43210/mcp",
    "headers": [{ "name": "Authorization", "value": "Bearer <server-token>" }]
  }]
}
```

Stdio entries use `name`, an absolute `command`, `args`, and an `env` array of
`{ "name": "VARIABLE", "value": "value" }` pairs. HTTP and SSE entries use
`type`, `name`, `url`, and a `headers` array of the same pair shape. Malformed
entries and duplicate names refuse the whole request before spawning a child.
An omitted or empty list retains the provider's configured MCP defaults.

MCP configuration is trusted input from the ACP client: it can launch programs
and supply server credentials. Those explicit credentials go only to the named
MCP server's configuration; the agent's ambient environment still passes through
`childEnv`. Claude receives a private temporary config file (owner-only POSIX
permissions, or an ACL granting only the running identity access on Windows),
removed when its child exits or fails to spawn. If Windows ACL protection fails,
no credentials are written and no child is spawned. Codex receives per-thread
JSON config overrides. The
package does not edit the provider's persistent MCP settings. Provider policies
and connection failures still determine whether a forwarded server can connect.

### Commit streamed messages at the turn boundary

`agent_message_chunk` and `agent_thought_chunk` carry no message id. The turn
boundary is the only delimiter between replies, so commit the accumulated
message there. Clearing the in-flight message without committing loses the
reply (including the whole reply in a single-message turn); not clearing it
appends the next turn to the previous one.

### Tool call updates

A recognized `tool_call` opener includes ACP's `kind`. Streaming tool arguments
are not on that opener; `rawInput` arrives on `tool_call_update` after the
arguments finish streaming. The closing `tool_call_update` carries `content`.

Tool titles and approval reasons are UI chrome, so the drivers strip terminal
control sequences before sending those labels. Tool-result `content` and
`rawInput` are data and stay verbatim: result text may contain meaningful color
codes for terminal clients, and `rawInput` preserves the provider's exact
arguments. Clients should not assume control sequences have been removed from
content or input data. Permission requests report `providerTextSanitized: true`
in `_meta` when their title or reason changed; tool-call titles do not yet report
that flag.

### Background tasks (Claude)

Claude Code reports the shells it runs with `run_in_background`, its Monitor
watches and its subagents on the stream. ACP has no field for them (its
`subagent_update` publishes no payload shape), so each frame becomes one
`notice` at level `debug` with the detail in `_meta`:

```ts
import { META_BACKGROUND_TASKS, META_TASK } from '@particle-academy/prism-acp';

// message 'background tasks' -- the FULL live set; replace your cached set with it
update._meta?.[META_BACKGROUND_TASKS];
// [{ taskId, runId?, taskType, subagentType?, description, parentTaskId?, ambient? }]

// message 'task started' | 'task progress' | 'task updated' | 'task ended'
update._meta?.[META_TASK];
// { event: 'started' | 'progress' | 'updated' | 'ended', taskId, runId?, toolUseId?,
//   description?, taskType?, subagentType?, isBackgrounded?, spawnDepth?, parentTaskId?,
//   ambient?, patch?, status?, reason?, outputFile?, summary?, usage?, lastToolName? }
```

`META_BACKGROUND_TASKS` is `particle.academy/background_tasks` and arrives
whenever the set changes, including as `[]` when nothing is running. Claude Code
sends nothing at startup (and needs 2.1.203 or later), so reset the set to empty
when the agent process starts. `patch` is the `task_updated` change
(`{ status?, description?, endTime?, totalPausedMs?, error?, isBackgrounded? }`)
to merge into the task you hold by `taskId`; `usage` is
`{ totalTokens, toolUses, durationMs }`. Exclude `ambient` tasks from activity
indicators. Descriptions, summaries and errors have terminal control sequences
stripped, with `providerTextSanitized: true` when anything was removed; a frame
with no `task_id` is recorded as unmapped rather than sent.

## Stopping a turn: `session/cancel`

`session/cancel` ends the **turn**, not the session, wherever the driver can
interrupt one. A driver that can implements `cancel()`, and declares
`cancel: true` in its capabilities:

- **Codex** sends app-server `turn/interrupt` with `{ threadId, turnId }`. The
  [documented](https://learn.chatgpt.com/docs/app-server) success is `{}`, and
  the turn then completes with status `interrupted`, which ends the prompt with
  `stopReason: "cancelled"`. The app-server and its thread stay up, and the
  next `session/prompt` runs as a new turn. A cancel that arrives before
  `turn/start` has named the turn is sent as soon as it does; a prompt still
  queued behind startup is dropped and never reaches Codex.
- **Claude** writes `{ "type": "control_request", "request_id": …,
  "request": { "subtype": "interrupt" } }` to the CLI's stream-json stdin.
  - **Documented:** the [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/typescript)
    say a client may drive the CLI's control protocol directly with the
    `interrupt` control request. They also document the `control_request`
    envelope.
  - **Measured, not documented:** the docs don't give the request body. It was
    measured on 2026-10-15 on the owner's Claude Code with
    `npm run probe:claude-interrupt` (after `npm run build`):
    - the request was accepted;
    - the turn ended 11 ms later with an `error_during_execution` result
      (`terminal_reason: "aborted_streaming"`, `is_error: true`), which the
      driver reports as `stopReason: "cancelled"`, not an error;
    - the process stayed alive, and the next prompt ran normally.
  - An aborted result the driver did not ask for stays an error. Re-run the
    probe when the CLI changes.
  - **`cancel_queued` is not set.** Measured without it, a message queued on
    stdin at the moment of the interrupt still ran. Through ACP there is never
    such a message, because a session runs one turn at a time. The flag's
    effect on this CLI hasn't been measured.

Once a client has cancelled, the prompt is answered `cancelled` even if the turn
finished or failed in the race with the interrupt, as ACP requires. If the
interrupt itself is refused, the agent is stopped instead, so Stop always stops.
A driver an embedder writes without `cancel()` gets that same stop.
A cancel with no turn in flight does nothing. Closing the connection still stops
every agent.

## Ending a session ends every process it started

Each CLI runs under a small supervisor that owns its whole process tree -- the CLI, its MCP servers, the shells and tool
subprocesses they start, `detached` ones included -- and never through a shell:

- **Windows:** the CLI is created suspended inside a Job Object (`KILL_ON_JOB_CLOSE`, no breakaway) before it runs a
  single instruction. The supervisor is built once per install with the `csc.exe` of .NET Framework 4, into
  `%LOCALAPPDATA%/prism-acp/supervisor-<source hash>/`, and its SHA-256 is checked before every launch. If it cannot be
  built or verified the driver refuses to start, naming the cause, rather than run uncontained. Call
  `prepareProcessTree({ directory? })` at startup so that surfaces once, before the first session.
- **Linux:** the CLI leads its own process group, and descendants that leave it are found through `/proc` by parent and
  by a per-launch `PRISM_ACP_TREE_ID` cookie in their environment. Not caught: one that clears its environment, leaves
  the group and is orphaned. **macOS:** the process group only.

A pid is never signalled unless its start time still matches, and the tree also ends when the CLI exits on its own or
the host dies (on Windows, by the kernel; elsewhere, when the supervisor sees its control socket close).

```ts
const verdict = await driver.stop({ graceMs: 5_000 }); // close stdin, wait, end the tree, then report
// { graceful: false, empty: true, survivors: 0, verified: true }
driver.processTree; // { providerPid, supervisorPid, containment: { kind: 'job-object' } | { kind: 'process-group', pgid } }
```

`kill()` ends the tree too, without waiting to report. On Windows a `.cmd` is run only if it is an npm shim (as node +
its script), and the current directory is never searched for the binary. To run a script as the provider, name the
interpreter and pass the script first: `{ binary: process.execPath, binaryArgs: ['/abs/stub.mjs'] }`.

## Driver capabilities

When the embedder identifies the selected driver, `initialize` declares its
measured behavior in `_meta` under
`particle.academy/driver_capabilities`. The object carries
`permissionRequests`, `transcriptReplay`, `mcpCapabilities`, `promptBlocks` and
`cancel` (whether `session/cancel` keeps the session; label Stop from it). If the key is absent, capabilities
were not declared; absence does not mean `false`. Claude reports
`permissionRequests: false` today, and that is expected to change when its
permission bridge lands. Read this declaration at runtime rather than caching
capabilities against a provider name.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run test:live` opts into real Claude and Codex children and uses the
authenticated CLI subscriptions. The Codex case checks for the home directory
at `CODEX_HOME` or `~/.codex`; if it is missing, Vitest reports a skip naming
the path. It does not inspect a credential filename. It includes a live Codex
turn cancel: `turn/interrupt` accepted, the turn's raw status `interrupted`, the
app-server neither closed nor exited, and the next prompt reaching `end_turn`.

## License

MIT
