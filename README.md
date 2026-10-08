# prism-acp (TypeScript)

Speak the [Agent Client Protocol](https://agentclientprotocol.com) to a
coding-agent CLI **the user has already authenticated**.

A client — an editor, a terminal UI, an orchestrator — gets structured state
from an agent instead of guessing it from bytes on a pseudo-terminal: session
state, streaming assistant output with thought content separable, tool calls
with status, a plan that changes in place, mid-turn permission requests it can
answer, token usage and cost.

```sh
npm install @particle-academy/prism-acp
```

**Zero runtime dependencies.** It drives the agent CLI already on the machine,
so the user's existing subscription login is the authentication — there is no
API key to supply and no adapter program to install.

## Status

Early, but a client can talk to it. `initialize`, `session/new`,
`session/load`, `session/prompt` and `session/cancel` work over a pipe. Claude
has been proven end to end against an authenticated binary; Codex is driven
through its App Server and tested against a fake transport, with the wire
shapes measured against captured traffic.

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
| Codex App Server driver | built; paged history and permission requests |

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
replay, so a Codex `session/load` will carry that human text. The mapping also
does this for live items, so a live Codex turn may echo the client's own prompt
as `user_message_chunk`; this is what our mapping allows, not a claim about
every Codex frame. Record the human turn yourself for both providers, and treat
a live `user_message_chunk` as the agent's record of what it received, not as
new input to append again.

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

Codex App Server approvals become ACP `session/request_permission` requests.
The driver offers the decisions Codex sent, including the persistent
execpolicy-amendment choice; its argv is kept on that option under
`particle.academy/execpolicy_amendment` so a client can preserve the distinction
between one-time approval and a remembered command. Human decisions have no
default timeout. Cancelling a session, disconnecting the ACP client, or shutting
down the driver answers any outstanding Codex approval with `cancel`.

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
import { serve, ClaudeDriver } from '@particle-academy/prism-acp';

serve({
  input: process.stdin,
  output: process.stdout,
  driverFactory: (options, events) => new ClaudeDriver(options, events),
  probeSession,
});
```

A client then speaks ACP on those pipes. Several sessions run at once, each with
its own agent process, its own in-flight turn and its own updates — tagged with
the session they belong to, because a room of agents shares one stream.

### Commit streamed messages at the turn boundary

`agent_message_chunk` and `agent_thought_chunk` carry no message id. The turn
boundary is the only delimiter between replies, so commit the accumulated
message there. Clearing the in-flight message without committing loses the
reply (including the whole reply in a single-message turn); not clearing it
appends the next turn to the previous one.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## License

MIT
