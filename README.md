# prism-acp (TypeScript)

Speak the [Agent Client Protocol](https://agentclientprotocol.com) to a
coding-agent CLI **the user has already authenticated**.

A client — an editor, a terminal UI, an orchestrator — gets structured state
from an agent instead of guessing it from bytes on a pseudo-terminal: session
state, streaming assistant output with thought content separable, tool calls
with status, a plan that changes in place, token usage and cost. Codex can raise
mid-turn permission requests for the client to answer. Claude can do so for the
tools explicitly configured through its optional `permissionPrompts` hook.

```sh
npm install @particle-academy/prism-acp
```

**Zero runtime dependencies.** It drives the agent CLI already on the machine,
so the user's existing subscription login is the authentication — there is no
API key to supply and no adapter program to install.

## Status

**Claude Code minimum: 2.1.203.** Individual features below retain their higher version requirements and exact
measured restrictions. Permission-rule argv is measured on native 2.1.203, 2.1.295, 2.1.311 and 2.1.322;
CI checks the first three on Windows and Linux. Other versions are not implied to have been measured.

`allowedTools` and `disallowedTools` use the [documented CLI form](https://code.claude.com/docs/en/cli-reference):
each array entry is one argv value after a single flag. For example, `['Bash(echo hello, world)', 'Read']` stays
two values, including the comma and space inside the Bash rule. These are Claude's permission rules; `allowedTools`
auto-allows matching calls and does not restrict the available tool catalog. Empty arrays omit the flag. Malformed,
empty, option-shaped, control-bearing or malformed-Unicode entries throw exported `ClaudeToolRuleError` before launch;
its `field` and `index` identify the invalid entry without including rule content in the error. Driver construction
snapshots both arrays. The prior comma-joined form also denied the probe on all four measured CLIs: this change is
hardening toward the documented form, with no reproduced fail-open on those versions.

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

### Plans

Codex sends its plan whole, and it goes to the client as `plan`, with every
entry's required `priority` (`medium`; Codex has none).

A driver that keeps its own plan projects it with `planUpdate(snapshot, client)`:

```ts
import { clientAcceptsPlanUpdates, planRemoved, planUpdate } from '@particle-academy/prism-acp';

// In a DriverFactory: options.clientCapabilities is { plan: boolean }, read from the client's initialize.
events.onUpdate?.(planUpdate({ planId, revision, planStatus: 'active', holdingApprovalId: null, steps }, options.clientCapabilities ?? { plan: false }));
```

- A client that advertised `clientCapabilities.plan` gets `plan_update`, keyed
  by `planId`. Any other client gets the full-replacement `plan`.
- `planRemoved` returns `plan_removed` for the first kind of client, and `null`
  (send nothing) for the second.
- ACP has no failed or skipped status, and `completed` means "successfully
  completed". So a failed or skipped step is shown unchecked, labelled
  `[failed]` or `[skipped]`. A person's step is labelled `(you)`.
- Each entry's real state is in `_meta["particle.academy/plan_step"]`. The
  plan's revision and status are in `_meta["particle.academy/plan"]`.
- Titles are treated as model text, and **a model-written title is always
  shown with `Step: ` in front**. An entry's text is the host's labels
  (`[failed] `, `[skipped] `, `(you) `, written only from the step's state
  and owner), then `Step: `, then the title: `[failed] (you) Step: Sign off`,
  `Step: Run the tests`. So nothing a model writes can stand where a host
  label stands, however it is spelled. A title that is empty once cleaned is
  shown as `Untitled step`, which is host text.
- Before that, controls and invisible characters are removed, fullwidth forms
  are folded (NFKC), every Unicode space becomes a plain one, and the result,
  prefix included, is capped at 160 characters. Codex plan step text is
  cleaned and prefixed the same way; a Codex step with no text is shown as
  `Step 1`, `Step 2`, ... by position.
- This replaced an earlier rule that prefixed only titles that looked like a
  label. That rule was a list of look-alikes and could always be spelled
  around, so it is gone: every title now carries the prefix, including plain
  ones such as `Run the tests`. A client that showed `Run the tests` before
  shows `Step: Run the tests` now.
- A snapshot with an unknown state, owner or status, or a bad id, throws
  `PlanProjectionError`.

`AcpAgent` checks every plan update a driver sends, whichever driver sent it.
It never sends `plan_update` or `plan_removed` to a client that did not
advertise `plan`. For that client, an items `plan_update` is sent as `plan`, and
anything else is dropped and reported. A plan with an entry that is not an
object with a string `content` and a status of `pending`, `in_progress` or
`completed`, or with a `_meta` (on an entry, the plan or the update) that is
not a plain object, is not sent at all, and that is reported. A `_meta` is sent
as its JSON serialization read back, so one that serializes as anything but an
object (an own `toJSON`), or cannot be serialized (a `BigInt`), is refused the
same way. `plan_removed` follows the same rules. Only an object's own
properties are read, a read that throws refuses the update (it is reported, not
thrown back into the driver), and what is sent is built from the checked
fields, so nothing else the driver attached goes with it. An entry without a
valid priority is sent as `medium`, and that is reported too. An entry
`content` longer than `PLAN_ENTRY_CONTENT_MAX` (1024 code points), or a
`_meta` whose JSON is larger than `PLAN_META_MAX_BYTES` (16384 bytes, on an
entry, the plan or the update), refuses the whole update, and that is
reported. So does an update with more than `PLAN_ENTRIES_MAX` (256) entries,
which is counted before any entry is read. The same applies to markdown
`content` longer than `PLAN_MARKDOWN_MAX` (65536 code points), a `path` longer
than `PLAN_PATH_MAX` (4096), and a `planId` longer than `PLAN_ID_MAX` (256)
or containing a control, format or invisible character. Entries are counted
from one read of `length` and read by index, so an iterator or `Proxy` of the
driver's own cannot add more.
Every update's
`sessionUpdate` is read once, from the update's own property; one without its
own string `sessionUpdate` is not sent and is reported. Every update that is
not a plan is sent as its JSON serialization read back, never as the driver's
object, and only if that serialization is an object with the same
`sessionUpdate`. One that serializes as another kind (an own `toJSON`, or a
getter or Proxy that answers differently the second time) or cannot be
serialized (a `BigInt`) is not sent, and that is reported. If the host's `onProtocolError` throws, that is
contained: it does not reach the driver or change what is sent.

## Why drive a CLI rather than call an API

Because of the authentication, and it is the whole reason this package exists.

A provider **API** client needs an API key and bills per token. A user who pays
for a subscription already has working credentials — in the CLI's own store, not
in any protocol — and the way to use them is to run the CLI they belong to. So
this package spawns the agent binary and translates, rather than reimplementing
the agent against an HTTP API the user has no key for.

In subscription mode (the default) that also keeps the credential out of this
package entirely: it never reads one, never holds one, and never puts one on a
wire. An app that bills per token instead can hand the drivers an API key; see
[API keys instead of a subscription](#api-keys-instead-of-a-subscription).

## Reuse an existing subscription in host mode

Subscription mode uses the CLI's own existing login. Prism does not read, parse,
copy, hash or share the user's stored credentials or token files; the native CLI
owns that store. A new sign-in is not required for an account already signed in.
An app still owns the explicit decision to bind its principal and session to that
machine account. Login metadata alone is not authorization or proof of model access.

```ts
const driver = new ClaudeDriver({
  cwd: appOwnedWorkingDirectory,
  credentials: { mode: 'subscription' }, // also the default
  nativeTools: 'none',
  mcpServers: appSuppliedUiMcpServers,
});
driver.start();
const models = await driver.modelState(); // control initialization; no model turn
// The app authorizes any later prompt and every UI MCP action.
await driver.stop({ graceMs: 0 });
```

Use a fresh Claude2.1.311 session. Omit `processTree.windowsStdio` (or omit
`processTree` entirely): this recipe runs in the host, without LOCAL/AppContainer
transport. Preserve the trusted host's original home/config environment; do not
redirect it to an empty home or import credentials. The environment builder
withholds billing credentials that would outrank the subscription. Explicit
app-supplied API keys and MCP credentials remain separate, app-owned inputs.

`nativeTools: 'none'` restricts the measured CLI's agent capabilities and inherited
settings/MCP, while the process retains the host user's OS authority. It is not an
OS sandbox. No credential-file grant, credential copy or sharing into a container
is part of this recipe. The app owns principal, role and session checks for its
supplied MCP server. Pre-turn `mcpServers === null` means no report yet, not zero
servers. Model lists are metadata, not an inference entitlement check.

Codex remains limited to the published `CODEX_NATIVE_TOOLS_NONE` matrix:
CLI0.163.0 with explicit `gpt-5.3-codex`. A recognized CLI or existing ChatGPT login
does not make another model safe. The measured host account advertises
`gpt-6.1-sol` as its default and does not advertise `gpt-5.3-codex`; restricted reuse
of that default is refused. Do not fall back to native execution or relax the
model guard to accept it.

The standing workstation check initializes against an existing Claude subscription
without a prompt or turn. It guards Prism-side file reads and uses an owned
metadata-only MCP fixture. It never reads or copies token files. Hosted CI has no
user subscription, so this opt-in is explicitly skipped there:

```powershell
$env:PRISM_ACP_EXISTING_SUBSCRIPTION = '1'
npm run build
npx vitest run test/existing-subscription.test.ts
```

Run it only where the measured CLI is already signed in; an absent login fails.
The native CLI may maintain its own cache/diagnostic state. This test establishes
login metadata and restricted initialization, not a successful model turn or
model-emitted native-tool refusal under the account.

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

## Remote control is forced off

Every CLI this package launches runs with remote control off. No option turns
it back on.

**Claude Code.** Every launch passes `--settings` with
`{"disableRemoteControl": true}`. That covers a session, a resumed session,
`nativeTools: 'none'`, and the short launch `listModels('claude')` makes. When the
driver already writes a private settings file (for approval hooks or
`disabledMcpServers`), the key is merged into that file and written last, so the
file keeps the driver's other keys. Otherwise the value is passed inline. There is
exactly one `--settings` on the argv. A `binaryArgs` entry of `--settings`,
`--remote-control`, `remote-control`, `--cloud`, `--remote` or `--teleport` is
refused before anything starts, including padded and case-changed spellings.
`claudeArgs()` used on its own adds the same inline value. If you pass it a
settings file path, build that file's contents with `claudeLaunchSettings()`.

The sources:

- [Settings reference, `disableRemoteControl`](https://code.claude.com/docs/en/settings-reference#disableremotecontrol):
  "Turn off Remote Control: Claude Code then refuses `claude remote-control`, the
  `--remote-control` flag, auto-start, and the in-session toggle."
- [Settings](https://code.claude.com/docs/en/settings): `--settings` is applied
  "above your user, project, and local files and below managed settings", and
  "Nothing in your own settings files or `--settings` overrides a managed key."
  Nothing is written to the user's own files.
- [Remote Control](https://code.claude.com/docs/en/remote-control): "To turn
  Remote Control off entirely, use the `disableRemoteControl` setting."
- The `-p` stream-json launch used here is not immune by itself. The 2.1.224
  changelog fixed "a session resume silently reconnecting Remote Control after
  the user turned it off (`--resume`, SDK hosts, and the VS Code extension)".

**Optional, blunter switch.** `disableFeatureFlags: true` (on `ClaudeDriver` and
`listModels`) also sets `CLAUDE_CODE_DISABLE_FEATURE_FLAGS=1` and its older name
`DISABLE_GROWTHBOOK=1` in the child's environment. It is off by default because it
turns off more than remote control. The
[environment variables page](https://code.claude.com/docs/en/env-vars) says: "With
this variable set, Remote Control and the other features that need feature-flag
fetching are unavailable. Requires Claude Code v2.1.319 or later." The features
it lists as needing feature-flag fetching include cross-machine session messaging,
`claude import` and `/skill-doctor`. v2.1.124 through v2.1.318 read only
`DISABLE_GROWTHBOOK`.

**Codex.** Codex has no documented per-launch off switch, so here it is off by
construction rather than by a setting. The launch is
`codex app-server --listen stdio://`. It never carries `--remote-control`, never
runs `remote-control` or the `app-server daemon` subcommands, and never opts into
the experimental API. A `remoteControl/*` JSON-RPC request or notification is
refused (`RemoteControlRefused`) before it is written, whatever transport the
embedder supplies. A `binaryArgs` entry that names remote control, `daemon`,
`cloud` or `--remote` is refused before launch.

**What this does not cover.**

- **Managed (admin) policy.** A managed `disableRemoteControl: false` outranks
  `--settings`. That is documented precedence, and this key is not in the
  "Exceptions to managed settings precedence" table.
- **Claude cloud sessions, teleport and share links.** `--cloud` (and its
  deprecated alias `--remote`), `--teleport`, `/teleport` and session sharing have
  no documented local switch. The only control is the organization's
  `allow_remote_sessions` policy
  ([Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)).
  This package never passes those flags, but it cannot stop a prompt that types
  `/teleport` or an agent's shell tool that runs `claude --cloud`.
- **Codex for admins.** The only documented hard switch is
  `allow_remote_control = false` at the top level of the system
  `requirements.toml` (`%ProgramData%\OpenAI\Codex\requirements.toml` on Windows,
  `/etc/codex/requirements.toml` elsewhere). The
  [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  says: "Set to `false` to disable device remote control for managed users." The
  [managed configuration guide](https://learn.chatgpt.com/docs/enterprise/managed-configuration#disable-device-remote-control)
  adds: "This requirement doesn't disable SSH remote connections." It is
  machine-wide admin policy, so this package documents it and never writes it.
  Whether `-c allow_remote_control=false` works per launch is not documented.
  The `remoteControl/*` RPCs are not documented either. They were observed in the
  0.163.0 schema with `--experimental`.

## Claude settings and MCP configuration

Choose the file-based settings sources and MCP configuration independently:

```ts
new ClaudeDriver({ cwd, settingSources: ['user'], strictMcpConfig: true, mcpServers });
```

`settingSources` accepts `user`, `project`, and `local`. Omit it for the CLI's
defaults, or pass `[]` for no file-based sources. `strictMcpConfig: true` passes
`--strict-mcp-config`, so the CLI uses only explicitly supplied MCP configuration.
Explicit `--settings` hooks and the driver's supplied MCP configuration still
apply. These options apply to fresh and resumed launches; pass the same driver
configuration when constructing a replacement driver. `nativeTools: 'none'`
always selects no file-based settings sources and strict MCP configuration.

### Append files and plugins

```ts
new ClaudeDriver({
  cwd,
  appendSystemPromptFile: '/srv/app/prompts/rules.txt',
  pluginDirs: ['/srv/app/plugins/review', '/srv/app/plugins/extra.zip'],
});
```

`appendSystemPromptFile` passes `--append-system-prompt-file`. `pluginDirs` accepts
plugin directories or ZIP files and passes each entry as a separate `--plugin-dir`.
Paths must be absolute strings without control characters or malformed Unicode.
The constructor validates values and copies the plugin list; validation errors
do not include path values or file contents. A nonempty plugin list is refused
with `nativeTools: 'none'`; an empty list preserves that policy.

Both options are passed on fresh, resumed and replacement launches. The CLI's
[recorded system prompt](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations)
still governs what the model receives: on Claude Code 2.1.311 and 2.1.312, resuming with a
different append file retains the conversation's original prompt. Passing a new
file does not immediately replace that recorded text. The driver preserves the
CLI's snapshot policy.

## API keys instead of a subscription

A deployment uses either the person's subscription or API keys, and an app may
offer its users or tenants either. So credentials are app or tenant
configuration, passed to the driver (and to `listModels`) by the embedder, never
something an ACP client sends:

```ts
new ClaudeDriver({
  cwd,
  credentials: { mode: 'apiKey', apiKey: process.env.TENANT_ANTHROPIC_KEY!, home: '/srv/app/tenants/acme/claude' },
});
new CodexDriver({
  cwd,
  credentials: { mode: 'apiKey', apiKey: tenantOpenAiKey, home: '/srv/app/tenants/acme/codex' },
});
```

`home` is the CLI's configuration home for that app or tenant
(`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex). It is what keeps the
person's own login untouched: Claude gets the key in its environment, and Codex
is logged in with `account/login/start { type: 'apiKey' }`, each under `home`.
Measured with both CLIs: the person's `~/.claude` and `~/.codex/auth.json` were
not modified. Under the person's own home, Codex's API-key login would REPLACE
their ChatGPT login, so a `home` that is their subscription home is refused.

- The key is never put in argv and never logged; inherited credentials stay
  withheld in both modes. If the CLI echoes the key in a diagnostic, it is
  replaced with `[redacted]` before it reaches `onStderr` or `driver.stderr`,
  even when it arrives split across chunks. Codex's stderr is never forwarded
  at all, only the length of each withheld line.
- A `home` this package creates is restricted to the current user. Codex keeps
  the key in it (`auth.json`, plain text), so treat the directory as a secret.
- **The agent can reach its own key.** Claude's key is in the CLI's environment,
  which the commands and MCP servers it runs inherit unless the CLI removes it;
  Codex's is in `auth.json` under `home`. Anything running as the same OS user
  can read either, so tenants that must not reach each other's keys need
  separate OS users, not just separate homes. (A subscription login has the
  same property: the agent runs as the person whose login it is.)
- A home has its own settings, MCP servers, skills and session history: a
  session started under one home resumes under that home only.
- A bad key fails the first turn. Claude reports it as `kind: 'auth'`; Codex
  classifies a rejected key on its websocket as `httpConnectionFailed`, which
  arrives as `kind: 'other'` with that reason.
- For `session/load`'s session check with Claude, pass the same directory as
  `probeSessionStore(id, { configDir: home })`.

## Choosing a Claude account

A person can have more than one Claude account on a machine, such as work and
personal. Claude Code keeps one sign-in per configuration directory, so in this
package **an account is a directory**. The host picks which directory the next
launch uses. The library stores nothing. The host stores a label, the directory
path, and the email or organization that the CLI itself reported. Neither of
them stores a token or a key.

```ts
import { ClaudeDriver, claudeAccounts } from '@particle-academy/prism-acp';

const work = { configDir: 'C:/Users/me/.claude-accounts/work', method: 'subscription' as const };

// 1. Not signed in yet? Run the CLI's own sign-in, hidden, and open its URL in the browser.
//    See "Signing in from an app (no terminal)" below.
await claudeAccounts.login(work.configDir, { onUrl: openInBrowser });

// 2. Before a launch, ask the CLI what is signed in there.
const check = await claudeAccounts.check({ ...work, email: rememberedEmail }, { cwd });
if (check.state === 'mismatch') showWhichAccountAndBillingIsLive(check.account, check.differences);
if (check.state === 'signedOut') offerSignIn();

// 3. Launch in that account.
new ClaudeDriver({ cwd, configDir: work.configDir });
```

- `describe(configDir)` runs `claude auth status --json` with the same stripped
  environment that a launch gets. It returns `signedIn`, the `method`
  (`subscription`, `console`, `apiKey`, `none` or `other`, with the CLI's raw
  `cliAuthMethod`), a `billing` hint, and the `email`, organization and plan
  when the CLI prints them. It reads only named fields, so a field the CLI adds
  later never reaches you through it. It also returns `configDirectoryMatches`,
  which compares the directory the CLI says it used with the one you asked for,
  and `requestedConfigDir`, the directory the status was taken for (`null` for
  the default).
- `compare(selection, status)` checks that the status belongs to the selected
  directory before anything else. A status taken for another directory, or for
  the default when a path is selected (or the reverse), is a `mismatch` with
  `directory` in `differences`. Paths are resolved, so trailing and mixed
  separators do not count, and compared case-insensitively on Windows and
  macOS. `null` matches only a status taken with `CLAUDE_CONFIG_DIR` unset,
  never one taken with it set to the default's path.
- `configDir: null` means the CLI's default account: `CLAUDE_CONFIG_DIR` is
  removed from the child, including an inherited one. Do not pass the default's
  path (`~/.claude`) instead. When the variable is set, Claude Code looks for its
  global config inside that directory rather than at `~/.claude.json`. On macOS
  it also keys its Keychain entry to the directory. Leaving `configDir` out
  keeps the old behaviour, where an inherited `CLAUDE_CONFIG_DIR` passes through.
- `listModels('claude', { configDir })` uses the same choice. For `session/load`
  under an account, pass the same directory to `probeSessionStore(id, { configDir })`.
- `configDir` cannot be combined with API-key `credentials`, because those bring
  their own `home`.
- **No automatic switching.** If an account hits its limit, nothing here moves
  to another account. Switching without the person would need a stored key, and
  this package does not store one.
- **The library never opens a file under the directory.** The test suite
  watches every `fs` call during `describe`, `check`, `loginCommand` and a
  driver launch, and fails if any of them touches a path inside the directory.
  `login` and `logout` may create the directory, list its entry names and
  remove what a failed sign-in added. A second test watches them and fails on
  any other call there, and on any call that touches the credential file.
- **No `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` support.** The variable
  is withheld from the child like every other credential.

### Signing in from an app (no terminal)

`claudeAccounts.login()` signs an added account in without showing the person
a terminal. It runs the CLI's own `claude auth login` with that account's
`CLAUDE_CONFIG_DIR`, hidden, under the same process-tree supervisor and the
same stripped environment as a launch. The host gets one thing back: the
sign-in URL. The host opens it in the person's browser. The person finishes
Anthropic's own sign-in there, and the CLI saves the result in its own
directory. Nothing in this package reads, copies, stores or logs a credential.

```ts
import { ClaudeLoginError, claudeAccounts } from '@particle-academy/prism-acp';

const controller = new AbortController(); // the "Cancel" button
try {
  const status = await claudeAccounts.login('C:/Users/me/.claude-accounts/work', {
    method: 'subscription',              // or 'console' (API usage billing)
    onUrl: (url) => openInBrowser(url),  // only a checked https:// Anthropic/Claude URL arrives here
    onCodeRequested: (done) => askPersonToPasteCode(done), // rarely needed; see below
    signal: controller.signal,
    timeoutMs: 600_000,                  // the default: 10 minutes
  });
  if (status.signedIn) rememberAccount(status.email);
} catch (error) {
  if (error instanceof ClaudeLoginError) showWhyItStopped(error.code);
}

// Sign-out: the CLI's own `claude auth logout` in that directory, also hidden.
const after = await claudeAccounts.logout('C:/Users/me/.claude-accounts/work');
// after.signedIn === false
```

- **The URL normally finishes by itself.** The CLI starts a listener on
  `127.0.0.1` and hands its browser opener a URL that redirects there. This
  package sets `BROWSER` to a small helper in a private temporary folder. The
  helper passes that URL back to `onUrl` and opens nothing. So the browser
  returns the sign-in to the CLI, and no code is needed.
- **A pasted code is the fallback.** If the helper never receives the URL (a
  settings file can name another browser), the CLI's printed URL is used. That
  URL ends on a page that shows a code. The same happens if the CLI says the
  browser could not return the sign-in. In both cases `onCodeRequested` is
  called. The code it returns goes straight to the CLI's stdin. It is not stored,
  logged or put in an error message. Its `signal` fires when the sign-in ends
  some other way, so the host can close its paste box. Without
  `onCodeRequested`, such a flow stops with `codeRequired`.
- **Only Anthropic and Claude URLs.** `onUrl` receives only an `https://` URL
  whose host is exactly one of `CLAUDE_SIGN_IN_HOSTS` (`claude.ai`,
  `claude.com`, `platform.claude.com`, `console.anthropic.com`). It must have
  no user info and no port. Anything else stops the sign-in with `refusedUrl`
  and is never handed out. `claudeSignInUrl(url)` is the same check.
- **Cancel, timeout and failure leave nothing running.** The whole process tree
  is killed, the CLI and anything it started included. A directory the call
  created is removed. In a directory that already existed, only the top-level
  entries the call added are removed. Nothing that was there before is touched.
- **For added accounts only.** `configDir: null` and the default directory
  (`~/.claude`) are refused with `refusedDirectory`. These calls never sign the
  person's own default account in or out. `logout` of a directory that does not
  exist is `missingDirectory`.
- **Errors** are `ClaudeLoginError` with a `code`: `aborted`, `timeout`,
  `refusedUrl`, `noUrl`, `codeRequired`, `invalidCode`, `failed`,
  `refusedDirectory`, `missingDirectory`. The CLI's own text is not passed on.
- `loginCommand()` is **deprecated**. It still works, unchanged, for hosts that
  show the person a terminal.

Measured with claude-code 2.1.330 on Windows, with no TTY and no sign-in
completed: the CLI prints the manual URL and `Paste code here if prompted > `,
and still runs the whole flow. It hands `BROWSER` (or, on Windows by default,
`rundll32 url,OpenURL`) a separate URL with
`redirect_uri=http://localhost:<port>/callback`. It reads a pasted code from
stdin without a TTY. `claude auth logout` exits 0 with
`Successfully logged out from your Anthropic account.`

### Sharing threads across accounts

A thread can continue under whichever account is active. The account then sets
only the limits and the billing, not the history.

```ts
claudeAccounts.prepare(work.configDir, { sharedSessions: true });
// { configDir, sharedSessions: true, store: '<home>/.claude/projects', linked: 'created' | 'existing' }
```

- `prepare(configDir, { sharedSessions, store })` creates the directory if it
  is missing, private to the current user. Its parent must already exist. With
  `sharedSessions: true`, it makes `<configDir>/projects` a link to `store`. On
  Windows the link is a directory junction, which needs no admin rights. On
  other platforms it is a directory symlink. Calling it again returns
  `linked: 'existing'`.
- `store` defaults to the default account's `projects` folder,
  `~/.claude/projects` (`%USERPROFILE%\.claude\projects` on Windows). That is
  where Claude Code keeps transcripts and auto memory when `CLAUDE_CONFIG_DIR`
  is unset ([the .claude directory](https://code.claude.com/docs/en/claude-directory)).
  The store must already exist. `prepare` never creates it.
- Only `projects` is linked. `--resume` needs nothing else, so everything else
  stays per account: the login, `.claude.json`, `sessions/`, plugins and
  settings. Auto memory lives under `projects/`, so it is shared too.
- **It refuses, and changes nothing, rather than replace anything.** It throws
  `ClaudeSharedSessionsError` with a `code`. `realFolder` means the account
  already has its own history. `linkedElsewhere` means `projects` already links
  somewhere else. `unexpectedLink` means `projects` is a link but
  `sharedSessions` was not asked for. Moving an existing history is a decision
  for the person.
- It never reads a file's contents, and never touches anything in the directory
  except `projects`. The test suite watches every `fs` call to prove it.
- Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days by
  default) under `projects/`, whichever account is active. With a shared
  store, the shortest `cleanupPeriodDays` among the sharing accounts applies to
  all of them.

### What can move billing without anyone choosing it

These are Anthropic's rules
([authentication](https://code.claude.com/docs/en/authentication)). This
package closes the first one and makes the others visible as a `mismatch`.

- **An environment credential outranks the login.** The documented order is:
  cloud provider, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then
  `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then Anthropic profiles, and
  last the `/login` subscription. "In non-interactive mode (`-p`), the key is
  always used when present." The child never receives any of these from the
  parent, including `ANTHROPIC_PROFILE` and the Workload Identity Federation
  variables. A key that a settings file sets (`env`, `apiKeyHelper`) is not in
  the parent environment, so it cannot be withheld. `describe` reports it as
  `method: 'apiKey'`. Measured: with `ANTHROPIC_API_KEY` set, status hides a
  working subscription login completely. It does not test the key either, so a
  bogus key still reads `loggedIn: true`.
- **An expired login falls back.** After a subscription login expires,
  "requests can use that credential instead, billed to its organization".
  `loginExpiresAt` lets the host warn before that happens.
- **A Console login without an API key is stored outside the directory.**
  "Separate directories don't keep two Claude Console sign-ins without an API key
  apart, because Claude Code stores that kind of sign-in outside the
  configuration directory." Signing in that way also "signs you out of any
  claude.ai login stored on the machine". `loginCommand(dir, { method: 'console' })`
  returns both facts in `caveats`.
- **An active Anthropic profile file** (in `%APPDATA%\Anthropic` or
  `~/.config/anthropic`) is outside the child environment. When its mode is
  federation, it outranks a claude.ai login. The library cannot strip it. It
  shows up as a mismatch.

### The terms, and what they leave open

- Allowed: "an end user ... signing in to the unmodified Claude Code binary with
  their own Claude subscription"
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  Several accounts, one directory each, is documented in
  [authentication](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts).
- Forbidden: developers "may not collect, store, or intermediate Claude.ai
  credentials or session tokens — sign-in to a Claude account must complete
  through Anthropic's own flow"
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  That is why sign-in is always the CLI's own flow, finished by the person in
  Anthropic's page in their browser, and why there is no token path. `login()`
  only starts that flow and passes its URL on; it never sees what the CLI
  receives.
- Limits: "Advertised usage limits for Pro, Max, and Ultra plans assume
  ordinary, individual usage of Claude Code and the Agent SDK" (same page). The
  [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) §3 forbid
  access "through automated or non-human means" except "via an Anthropic API Key
  or where we otherwise explicitly permit it".
- **Unclear:** whether several accounts may run sessions at the same moment. No
  Anthropic source addresses it. Also unclear: whether agent runs that an app
  starts for its user count as "ordinary, individual usage". The sign-in
  carve-out covers a person signing in. It does not say how much autonomous
  work that sign-in may then carry. Read these pages again before you rely on
  this; Anthropic has changed them before.

## Framing is pinned, not inferred

This package exists in three languages, and framing is where three
implementations of one protocol disagree without anyone noticing. So:

- a trailing `\r` is **stripped**, not left to each language's JSON parser to
  tolerate;
- `MAX_LINE_BYTES` is **64,000,000** in every port, because a cap that differs
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
environment. The hook accepts Claude Code **2.1.295 or later**; **2.1.310** is tested in native Windows/Linux CI. In that version,
`onFailure: "block"` blocks failures and timeouts, but an empty or plain-text exit0 still runs the tool. An exit adapter
therefore accepts only the script's reserved explicit-allow status; a worker validates the complete decision before
any allow reaches Claude. Missing, extra or malformed output, cancellation, errors and expired approvals deny.
The driver holds prompts and EOF until control initialize reports a valid version of at least 2.1.295. Missing,
unparseable or older versions, initialize errors/timeouts, and later system/init version omissions/changes close the
session. Versions 2.1.295–2.1.309 are accepted on Anthropic's documented `onFailure` semantics and have not been measured
by this suite. `system/init` arrives after the first user prompt on 2.1.310, so its version alone cannot gate that prompt.

Inside Electron, the hook runs the app executable with `ELECTRON_RUN_AS_NODE=1` for that hook only. The script removes
the flag before its worker or any child starts; the POSIX supervisor also removes its injected flag before starting
a provider. Hook paths are passed as arguments rather than interpolated into shell commands. Windows uses an approval
mode in the shipped native C# supervisor; POSIX uses `/bin/sh`. Windows x64 and ARM64 executables are built
reproducibly in CI and verified against pinned Authenticode image digests before every use. There is no runtime
compiler, executable cache or interpreter fallback. Missing, quarantined or altered executables refuse startup. Its byte
handles preserve JSON output, and a per-call Job Object ends helper descendants when the adapter exits. If an Electron
build disables Node mode, the call denies. An app can supply
`permissionPrompts.nodePath` as a trusted absolute ordinary Node executable instead. This option belongs to app
configuration and must never come from model or ACP client input.

Windows x64 requires Windows 10/11 with the installed CLR4. Native ARM64 requires Windows 11 with .NET Framework
4.8.1 (included in Windows 11 22H2 and later); Windows 10 ARM64 is refused before a provider starts. The package
selects the physical machine architecture and does not fall back to an emulated supervisor.

Electron hosts can unpack and sign the executable as part of their own distribution:

```ts
import { prepareProcessTree, supervisorPath } from '@particle-academy/prism-acp';

const packagedExecutable = supervisorPath('x64'); // Also accepts 'arm64' when staging a distribution.
// Copy packagedExecutable to your unpacked assets and sign that copy in your distribution pipeline.
await prepareProcessTree({ executable: absoluteUnpackedExecutable });
```

`executable` is trusted host configuration, never model or ACP client input. The selected file is checked on each use.
Authenticode signing can change the certificate table and checksum while preserving the pinned program image;
the image check does not validate a certificate chain or grant publisher trust. Files inside an `.asar` archive must be
unpacked first. The old `directory` option remains accepted and ignored, with one
`PRISM_ACP_SUPERVISOR_DIRECTORY_DEPRECATED` warning directing hosts to `executable`.

Release CI can publisher-sign both Windows images with [Azure Artifact Signing](https://github.com/Azure/artifact-signing-action).
The Windows build job reproduces the committed unsigned images in two clean roots without an Azure identity.
A separate signing job uses GitHub OIDC in the protected `release` environment and runs no dependency installation
or build. Inline PowerShell first checks both unsigned executable SHA-256 values against reviewed workflow literals.
A bootstrap hash pinned in that workflow then authorizes the downloaded verifier manifest and code before
execution; producer-generated hashes cannot authorize changed code or native-image pins. The signer checks
the reviewed image digests, a valid Windows Authenticode signature and timestamp, then records the signed files'
SHA-256 values. The npm job selects the signed payload when required and the staged unsigned payload otherwise. It checks that receipt and the
actual tarball before publishing. Runtime image verification and the host-supplied executable option are unchanged.

The repository variable `REQUIRE_SUPERVISOR_SIGNING=true` requires signing and refuses publication if any of these
`release` environment variables are missing or invalid: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID`.
The workflow uses the existing `renaissance-analytics` account, `genie-public` profile and
`https://eus.codesigning.azure.net` endpoint; it requires signer subject name `Renaissance Analytics`. Authentication uses a federated
identity with subject `repo:Particle-Academy/prism-acp-ts:environment:release`; no stored signing secret or key is used.
Until the owner enables that repository gate, an unset or exactly `false` value skips the signing job and publishes the same reviewed unsigned
images as 0.41.0. Other gate values refuse publication. The npm job remains outside the `release` environment.
The signing workflow's real Azure execution and publisher trust must be measured after account configuration;
offline tests and disposable test signatures do not establish that acceptance.

When changing the release verifier, generated image parser or package version, run `npm run build`, then
`node tools/supervisor-native/pin-signing-verifiers.mjs --write` and review the manifest, bootstrap and workflow
pin diffs together. `--check` refuses drift. Pin updates are a source-review action; a build artifact's own hashes
cannot change the reviewed workflow's authorization of verifier code.

`permissionPrompts.timeoutSeconds` sets the approval deadline (integer 1–86400, default 86400). The hook denies before
the native hook timeout. The permission hook is an application approval mechanism; it is not OS isolation.

`CLAUDE_DRIVER_CAPABILITIES.permissionRequests` describes the default and remains
`false`. When an embedder configures this hook, its `serve` declaration can report
the enabled capability:

```ts
driverCapabilities: { ...CLAUDE_DRIVER_CAPABILITIES, permissionRequests: true }
```

Only declare `true` for a runtime with the configured hook and permission handler.
`serve` supplies the handler that forwards requests to the ACP client. The
capability declaration itself does not install a hook or authorize a tool.
Claude's `allowedTools` option is a permission auto-allow list, following the CLI;
it does not restrict the catalog of available tools. Application authorization
remains the embedding application's responsibility.

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

`session/load` works with the Claude and Codex drivers, and `initialize` reports
`loadSession: true` for them. The trap is
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

Codex replay is enabled by default. Every update projected from saved history,
including its single debug summary notice, has
`_meta['particle.academy/replay'] === true` (`META_REPLAY`). Live notifications
keep their normal metadata even when they arrive while a history page is loading.
Replayed reasoning carries the source item id as `messageId`; replayed
compaction carries it as `itemId`.

To keep your own transcript without projecting the saved one again, set the
trusted `CodexDriverOptions.replayHistory` option to `false` in your driver
factory. This skips both `thread/turns/list` and `thread/items/list`, including
the replay summary. It still resumes the native thread with its saved model
context, so the next prompt can use that conversation. This does not enable
resume with `nativeTools: 'none'`, whose provenance restriction still applies.

The summary's `_meta['particle.academy/replay_summary']`
(`META_REPLAY_SUMMARY`) contains `turns`, `items`, `diagnostics`, `reasons`
(`{ reason, count }` entries), `omittedDiagnostics`, and `complete`. It replaces
per-item replay diagnostics without copying raw historical frames into notices.
At most 32 reason strings are retained, each sanitized and limited to 200
characters; excess occurrences count toward `omittedDiagnostics`. `complete`
reports whether pagination finished without an RPC or pagination failure;
invalid entries and unmapped item types still count as diagnostics. Live unmapped-frame diagnostics
are unchanged.

Codex assistant text uses `agent_message_chunk` with a single content object
during streaming, history replay, and completion without streamed deltas.
`messageId` carries the Codex item id, so clients can distinguish adjacent
assistant messages. Completion does not repeat text already streamed.

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

`CodexDriverOptions.config` passes JSON configuration to `thread/start` and
`thread/resume`, alongside the driver's MCP settings:

```ts
new CodexDriver({
  cwd,
  config: {
    project_doc_max_bytes: 0,
    'skills.config': [{ path: '/absolute/path/to/skill/SKILL.md', enabled: false }],
  },
});
```

Use `project_doc_max_bytes: 0` to omit project documents and list individual skill
files with `enabled: false` to disable them. Set `'skills.include_instructions':
false` to omit skill instructions, including skills added after a turn. Nested objects, arrays, booleans,
finite numbers, strings and null are accepted. Dotted top-level paths are
normalized to nested objects; overlapping paths are refused. Configuration is
copied and recursively frozen at construction, so later edits to the caller's
object do not change a pending launch. Supply it again when constructing a
replacement driver.

Driver-managed settings such as `mcp_servers`, model/provider selection, profiles,
approval and sandbox choices, shell environment policy and shell snapshots are
refused through `config`. Use the dedicated driver options where available.
With `nativeTools: 'none'`, its feature/tool controls are also reserved; per-file
skill settings and `skills.include_instructions: false` remain available. Values with accessors, custom prototypes,
cycles, non-JSON types or excessive size/depth are refused before launch. This is
trusted application configuration; never build it from model or ACP client input.

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
When Codex supplies `availableDecisions`, the driver offers only the recognized
choices in that list. When it omits the list (as in the generated `codex-cli
0.163.0` request schema), the driver offers allow once, allow for the session,
decline and continue, and cancel. Persistent command or network rules are offered
only when Codex explicitly proposes them. An empty or unrecognized explicit
list provides no grant. A persistent execpolicy amendment's argv is kept under
`particle.academy/execpolicy_amendment` so a client can preserve the distinction
between one-time approval and a remembered command. Managed network and terminal
input requests have distinct titles and retain their context in `rawInput`.
Human decisions have no default timeout. Cancelling a session, disconnecting the
ACP client, or shutting down the driver answers outstanding approvals with
`cancel`. Requests cleared by Codex or by turn completion ignore late UI replies.

A declined command or file change is a failed tool; the turn continues until
Codex sends `turn/completed`. Explicit foreign-thread and stale-turn events do
not contribute to the active turn and are reported through unmapped metadata.
Foreign-thread diagnostics omit the other thread's payload.
Command output streams as cumulative ACP content snapshots, retaining at most
the last 1,000,000 characters per active command and reporting any truncation.
Completion replaces that preview with Codex's aggregated output when available;
`rawOutput` also carries exit code and duration when reported. Resumed tool calls
retain their final status and results, including MCP and dynamic-tool text.

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
- **`status` and `overageStatus` are open string unions.** Every stream frame
  captured says `"allowed"`. Claude Code transcripts record rejections as
  `status: "rejected"` with the window and reset time but **no
  `unifiedWindows`**, so a rejection parses with `windows: {}` and has no
  percentage. No rejection has been captured off the stream itself and other
  spellings are unknown: test `status !== 'allowed'`, and never match a specific
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
Codex credit balances accept the CLI's decimal strings as well as numeric
values, normalizing them to a finite non-negative number in `credits.balance`.
Malformed balances are refused with a type-and-length diagnostic.

Both parsers accept usage beyond the allowance (`usedPercent` above 100 or
`utilization` above 1) without capping it. Overage is real state, and capping
would invent a reading; clamp only the rendered bar, not the reported value.

### One reading for any provider

To draw one gauge without knowing the provider, read
`particle.academy/rate_limit_reading` (`META_RATE_LIMIT_READING`). It sits beside
`particle.academy/rate_limit`, which is unchanged, and is plain JSON with no raw
payload, plan or account identifiers:

```ts
type RateLimitReading = {
  state: 'reported' | 'not_yet_reported' | 'unreadable' | 'unsupported';
  reason?: string;   // when unreadable; describes values, never quotes them
  asOfMs: number;
  limited: boolean;  // the provider clearly says usage is limited now
  windows: Array<{
    id: string;                   // claude:seven_day, codex:10080m
    label: string;
    lengthSeconds: number | null; // null = the provider did not state it
    usedPercent: number | null;   // not capped; null = not stated, never a guessed 100
    resetsAtMs: number | null;
    binding?: boolean;            // absent when the provider does not say
    limited?: boolean;            // absent unless this window's own status says so
  }>;
  absent: 'provider_says_none' | 'not_stated'; // how to read a window not in the list
};
```

- **An empty `windows` is not headroom.** Check `state` first, and show
  `limited` even when a window has no percentage: a Claude rejection names its
  window and reset time but reports no figure.
- **`absent` decides what a missing window means.** Claude is always
  `not_stated`, because one frame does not prove an account lacks a window.
  Codex is `provider_says_none` only on a full read with an explicit `null` slot
  and no omitted one.
- **Codex's live updates are sparse.** `account/rateLimits/updated` is meant to be
  merged into the last read, so its readings are `not_stated`, and one with no
  window and no limit emits no reading at all. Merge windows by `id`.
- **Ids follow length, not slot.** Codex can put its weekly window in `primary`.
  Two windows of one length get `codex:10080m` and `codex:10080m:2`.
- **Codex never sets `binding`.** Its reached-limit values name a cause, not a
  window.
- A refused payload gives `state: 'unreadable'`, no windows and the reason. An
  API-key session gives `unsupported`. Before the first frame, use
  `notYetReportedRateLimitReading(Date.now())`. `claudeRateLimitReading` and
  `codexRateLimitReading` are exported if you hold a payload yourself.
- `readRateLimits()` still resolves to nothing: the fresh reading arrives on the
  update it emits.

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
and supply server credentials. The agent's ambient environment still passes through
`childEnv`. Claude receives a private temporary config file (owner-only POSIX
permissions, or an ACL granting only the running identity access on Windows),
removed when its child exits or fails to spawn. If Windows ACL protection fails,
no credentials are written and no child is spawned. Codex receives per-thread
JSON config overrides. For an explicit HTTP Bearer Authorization header, the driver
instead gives that child a fresh environment binding and sends its name on both
thread start and resume. This prevents an inherited `bearer_token_env_var` from
selecting an older key, and keeps the supplied bearer out of the thread config.
The binding belongs to that provider process. Before starting or resuming its
thread, the driver reads the effective shell environment policy and appends an
explicit exclusion for every binding, preserving the user's existing exclusions
and settings. Keyed filter policies receive equivalent per-binding exclusions.
Malformed policies, incompatible array/filter combinations, and `set` entries
that would restore a binding are refused before a thread starts. The protection
does not depend on Codex's default secret-name exclusions. These controls govern
shell environment and snapshot persistence; they do not sandbox the native provider.
For these bearer-bearing sessions, the driver disables Codex shell snapshots:
the native snapshot otherwise writes exported bearer bindings to disk even
without a shell tool call. The parent environment is unchanged. Other authentication schemes and unrelated
inherited server fields retain the native provider's merge behavior. The
package does not edit the provider's persistent MCP settings. Provider policies
and connection failures still determine whether a forwarded server can connect.

A trusted host can also pass `disabledMcpServers: ['workspace']` to either driver
constructor to block named inherited servers for that run. This is host policy,
not a field accepted from ACP session requests or model output. Names must be
distinct and cannot also appear in `mcpServers`. Unrelated servers remain
available. Claude combines the deny list and any approval hooks in one private
settings file; separate `--settings` arguments would overwrite each other.
Claude documents `deniedMcpServers` as a
[managed-settings key](https://code.claude.com/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists).
Its use through `--settings` was measured on **Claude 2.1.310**; that measurement
does not guarantee the same behavior on every CLI version or managed installation.
Codex reads the effective configuration and supplies a disabled entry with a
valid transport, including when the name was previously absent. This option
does not provide wholesale replacement of inherited MCP configuration.

### Claude app MCP only

A trusted host can set `nativeTools: 'none'` on `ClaudeDriver` to remove native
execution, filesystem and web tools and use only its explicit `mcpServers`.
User/project/local settings and inherited MCP servers are excluded for this
invocation, including when the supplied server list is empty. This is constructor
policy, never a model argument or an ACP session field. The default driver keeps
its existing behavior.

```ts
const driver = new ClaudeDriver({
  cwd: assignedWorkspace,
  parentEnv: assignedProviderEnvironment,
  credentials: { mode: 'subscription' },
  nativeTools: 'none',
  mcpServers: applicationServers,
  // Optional, explicit per-tool permission rule; this does not narrow the catalog.
  allowedTools: ['mcp__workspace__read_document'],
  processTree: { windowsStdio: 'local-pipes', startupTimeoutMs: 5_000 }, // Windows
});
```

The measured CLI is **Claude Code 2.1.311**, and only fresh sessions are supported.
An unknown/missing version or `resumeSessionId` refuses; `bypassPermissions` also
refuses. At most one prompt waits for a successful control initialize response.
Malformed protocol data, inconsistent system/init versions and native/inherited
entries in the announced tool catalog close the process tree. The CLI announces
its catalog after receiving the first prompt: the pre-prompt boundary is the
validated CLI version and explicit launch controls, rather than that later notice.

This uses the CLI's [`--tools ""`, `--strict-mcp-config`, empty `--setting-sources`
and `--restricted`](https://code.claude.com/docs/en/cli-reference) together.
Claude's control-only `EndConversation` may remain while MCP tools are present;
it provides no execution, file or web route. Machine-managed policy still applies.
A conflicting managed configuration must be resolved by the embedding host;
this mode does not bypass an administrator's policy. Supplied MCP tools retain
the authority and permissions the host gives them.

The assigned `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` are preserved for
subscription mode; this option never adopts another login or creates a substitute
home. In API-key mode the existing explicit `credentials.home` contract applies.
Windows LOCAL mode creates temporary MCP configuration with a protected ACL at
creation, granting only the user and the actual AppContainer SID. The host must
provision a writable effective temp directory. Windows can rewrite `TEMP`/`TMP`
under the profile's `Packages/<profile>/AC/Temp`, even when the launch environment
supplied a different temp path. Parent directories and their grants are never
created or widened by this operation. Configuration is removed when the driver
stops or startup fails. `cancel()` interrupts the turn; `stop()` ends the process
tree and removes its configuration.

The LOCAL restricted driver refuses a missing or inaccessible effective temp
parent before starting the private-directory helper. Retargeting the host's
`LOCALAPPDATA`/home can change that effective profile temp path; provision the new
path before launch. Helper preparation errors remain distinct from native
`CreateDirectoryW` failures, which report their Windows error number and cause
without printing paths. The library never creates a missing parent as a fallback.

The native regression uses a synthetic key, `claude-sonnet-4-6` request shape and
owned loopback model/MCP servers. It proves a supplied MCP call, refusals of forced
Bash/Read/Write/WebFetch/inherited-MCP calls, and cancel/stop cleanup. Its
unrestricted control loads a planted inherited server and runs a planted hook.
CI installs exact 2.1.311 native executables on Windows and Linux. A separate
Windows test starts the actual CLI and discovers a supplied stdio MCP server
inside a zero-capability AppContainer; it performs no authenticated model turn
and adds no network exemption. Account/model entitlement and authenticated turns
must be validated in the embedding application's provisioned home and network.

### Measured Codex native-tool restriction

A trusted host can opt into `nativeTools: 'none'` on `CodexDriver` to remove
native execution, web/image/browser, agent, goal and human-input tools. The
default remains `'default'`. This option is host policy; ACP clients and model
output cannot set it.

```ts
import { CodexDriver, CODEX_NATIVE_TOOLS_NONE } from '@particle-academy/prism-acp';

const driver = new CodexDriver({
  cwd: assignedWorkspace,
  model: 'gpt-5.3-codex',
  nativeTools: 'none',
  mcpServers: applicationServers,
});
```

| Requirement | Supported value |
| --- | --- |
| Native Codex CLI | Exactly `0.163.0`, checked during initialize |
| Explicit model | `gpt-5.3-codex` |
| Thread | Fresh session only |
| MCP servers | Only explicitly supplied `mcpServers`; inherited server IDs are disabled |
| Remaining native helpers | `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` |

`CODEX_NATIVE_TOOLS_NONE` exports the immutable measured CLI/model/residual-tool
matrix. The three read-only resource helpers can access only the session's
supplied servers. Their presence means this is not an MCP-only tool surface.
The supplied MCP tools retain the capabilities and approval policy you give them.
An empty `mcpServers` list in this mode disables all inherited servers.

The effective home/project configuration is checked before thread creation.
Known native feature flags are forced off. Every other enabled feature must be
on the measured harmless-feature allowlist (`enable_request_compression`,
`api_key_model_discovery`, `api_key_cyber_access_programs`, `auth_elicitation`,
`mentions_v2`); an unreviewed flag such as `standalone_web_search` or `memories`
refuses. Unmeasured tool-specific settings, custom model catalogs and native
browser/computer/desktop/code-mode configuration refuse as well. Native web
search and human-input/plan/image settings covered by the policy are overwritten
with their restricted values. This avoids assuming an empty configuration home
when the application uses an existing one.

Restricted launches also disable `features.plugins` and `features.remote_plugin`
before starting App Server, using its measured `-c` overrides. A thread-only
policy arrives too late: native `0.163.0` can acquire a plugin marketplace during
startup before the first prompt. The driver requires both startup features to
be explicitly `false` in `config/read` before creating a thread. These launch
overrides apply only to `nativeTools: 'none'`; other feature settings and ordinary
launches keep their configured behavior. Owned-profile native tests wait ten
seconds for delayed acquisition, preserve an unrelated feature, then invoke the
supplied MCP tool. The positive control detects native plugin-source attempts at
a rejecting local proxy; CI never downloads those plugins or sends real model
requests. This prevents the measured startup acquisition path, without claiming
general filesystem isolation for the CLI.

Omitted or other models, unmeasured CLI versions, and `resumeSessionId` refuse
with a clear error. Model selection is limited to the matrix; an unsupported
native model reroute closes the driver **on its `model/rerouted` notification**.
Output and tool activity before that notification are not prevented. A local
fake-provider probe confirmed that an owned MCP tool can execute before delayed
reroute metadata arrives. A different `response.model` value alone produced no
native reroute notification, so the driver cannot independently verify backend
serving-model identity. The matrix applies to the CLI's configured model and
advertised/callable native tools. Resume is unsupported because a saved
thread can restore native agent tools even when its new configuration disables
them. Supporting resume requires trustworthy session provenance in a future
version. Ordinary-mode resume is unchanged.

The limit is measured rather than inferred from configuration flags. On CLI
`0.163.0`, `gpt-6.1-sol` still advertises native execution and collaboration tools
through `input[].additional_tools`, and `collaboration.list_agents` remains
callable after the feature policy is applied. That model is refused. A host
cannot treat a hidden top-level `tools` array as proof of removal.

This option governs native tool reachability; the CLI itself still runs with
its process permissions, reads its configuration and authenticates normally.
Use the process containment appropriate to your application.

With supplied MCP servers that expose no filesystem route, the package removes
the model's native routes to the scoped home's auth/config/session files. The
CLI itself retains normal trusted authentication reads and writes. A synthetic
home regression seeds three distinct sentinels, attempts hidden shell/file/image/
agent and MCP resource routes, and scans tool results, model input and outgoing
requests for disclosure. Native `account/read` must still recognize the dummy
auth file. Deliberately re-enabling the shell makes the disclosure assertion
fail, proving the check detects actual file access. This is a package tool-route
guarantee; the host owns OS isolation and MCP server authority.

The regression suite uses an installed CLI, empty owned homes, a dummy key,
loopback fake Responses and MCP fixtures, and a non-forwarding local proxy that
records and rejects auxiliary CONNECT attempts. It performs no real inference
or login and verifies that each owned process tree is empty after stop. Run
`npx vitest run test/codex-native-tools-live.test.ts` with
`PRISM_ACP_CODEX_NATIVE_TOOLS=1` and optionally `PRISM_ACP_CODEX_BINARY` set to
the absolute native binary. An absent CLI or unmeasured version fails when opted
in. CI runs this gate on Linux and Windows with pinned Codex `0.163.0`; it checks
both top-level `tools` and `input[].additional_tools`, rejecting unknown shapes
and any unexpected tool. It also proves working native execution in a control
and refusal under the supported restriction, resource scope, and model/version/
resume refusal. Hidden native execution and agent calls are also attempted and
refused **before** the fake provider sends a genuine reroute signal, independently
of the driver's notification-triggered shutdown. Working native shell and
recognized agent-tool controls distinguish removal from an invalid test call.

`bash scripts/probe-mcp-session-auth-gate.sh` is an opt-in Linux VM check. It
packs the proposed adapter, runs the installed Codex and Claude CLIs in an
isolated network namespace against local fixture servers, and verifies the
bearer and disable behavior. One turn receives a fixed response from the local
fixture to create a persisted Codex thread for the resume check; no external
model or inference service is used. It requires mise
for any shimmed binaries, passwordless sudo, `ip`, and a `genie` test user. It
also bypasses the packed bearer binding, snapshot protection, and each provider's
deny policy and both shell exclusion forms in turn, requiring the matching assertion to fail before testing
the restored package. It uses fixture keys and
isolated homes rather than the user's login.

Set `PRISM_MCP_PROBE_FIXTURE_ONLY=1` and `PRISM_CODEX_PROBE_BINARY` to the absolute
native binary, then run `node scripts/probe-codex-mcp-env.mjs /path/to/packed-package`
for native shell
environment controls on Codex 0.163.0: hostile `inherit="all"` and
`ignore_default_excludes=true`, preserved user exclusions and `set`, keyed filters,
fresh bearer on resume, unrelated feature retention and CLI-home persistence scans.
The model responses are deterministic loopback fixtures which request a real `env`
shell call; no external inference or user login is used. This portable probe alone
does not disable external networking. The Linux gate runs it in a loopback-only
network namespace and mutates the packed shell guards. On Windows it requires Git's
`C:/Program Files/Git/usr/bin/env.exe`. Dummy shell output stays in the private
fixture home and is never printed to the probe log; the fixture directory is removed.

### Commit streamed messages at the turn boundary

Every live `agent_message_chunk` from either driver carries `messageId` at the
update's root, beside `content`: the same field in the same place, so one
client handles both drivers identically. Group chunks by `messageId`, and treat
a new id as a new assistant message even inside one turn.

- **Codex**: the app-server item id.
- **Claude**: the Anthropic message id from the stream's `message_start`
  (`msg_...`). A reply that stops for a tool call or a subagent and then
  continues arrives as a NEW assistant message with a new id, so the two are not
  merged. When the stream gives no usable id (missing, or not a short opaque
  token), one is generated at that `message_start`, prefixed `prism_msg_`, and
  every chunk of that message carries it. A synthetic CLI message uses its own
  id the same way; a built-in command's output (`particle.academy/local_command`)
  gets a generated id of its own.

Commit the in-flight message when the id changes, and at the turn boundary for
the last one. Older clients and other ACP agents can still omit `messageId`;
then use the turn boundary alone. Clearing the in-flight message without
committing loses the reply (including the whole reply in a single-message
turn); not clearing it appends the next turn to the previous one.
`agent_thought_chunk` from a live stream does not carry `messageId` in either
driver.

### Why a turn failed

A turn that fails answers `session/prompt` with a JSON-RPC error whose `data`
holds `particle.academy/turn_failure` (`META_TURN_FAILURE`):

```ts
{
  reason: string;          // the provider's own code, e.g. 'cyberPolicy', 'rate_limit'
  kind: 'rate_limit' | 'overloaded' | 'auth' | 'billing' | 'other';
  resetsAtMs?: number;     // only when the provider said when the limit resets
  providerMessage?: string;                          // Codex only
  providerDetails?: Record<string, string | number>; // Codex only
  retryable?: true;        // kind 'overloaded' or 'rate_limit'; absent otherwise
  retryAfterMs?: number;   // only when the provider stated a wait; integer, 0..3_600_000
  resumable?: boolean;     // true: this session takes the next prompt; false: it is gone
}
```

#### Retrying an overloaded or rate-limited turn

When a provider answers "Overloaded" (HTTP 529) or "Too Many Requests"
(HTTP 429), the failure is `kind: 'overloaded'` or `kind: 'rate_limit'` with
`retryable: true`. Wait, then send the prompt again with `session/prompt` on
the SAME session. You do not need `session/load` or a new session.

```json
{
  "reason": "server_error",
  "kind": "overloaded",
  "retryable": true,
  "resumable": true
}
```

- **`reason` is still the provider's own value.** Claude Code 2.1.332 ends a 529
  with `error: "server_error"`. Codex 0.163.0 ends one with
  `httpConnectionFailed` (`providerDetails.httpStatusCode: 529`), or with
  `serverOverloaded` when the stream reports it. All of them are
  `kind: 'overloaded'`. A Codex `responseTooManyFailedAttempts` with status 429
  is `kind: 'rate_limit'`. Act on `kind`, not on `reason`.
- **`retryAfterMs` appears only when the provider stated a wait and the driver
  could read it.** It is never invented, and it is never the CLI's own backoff.
  Neither shipped CLI forwards the provider's `retry-after` today, so the
  shipped drivers do not send it. Choose your own backoff when it is absent. A
  driver you write can set it; it is capped at one hour and dropped unless it
  is a finite number of 0 or more. The failure is rebuilt from its JSON form,
  and only the fields above are sent, each checked again. An unknown `kind`
  becomes `other`, text is bounded and marked as provider text, and anything
  else a driver attached is dropped.
- **Both CLIs have already retried before you see the failure.** Claude Code
  retries 10 times by default with its own growing backoff, which is about two
  and a half minutes in total. It announces each attempt as an unmapped
  `system/api_retry` frame. If the provider's `retry-after` is too long, it does
  not retry at all. Codex retries according to its provider's
  `request_max_retries` / `stream_max_retries`, waits out `retry-after`, and
  sends an `error` notification with `willRetry: true` for each attempt. That
  notification does not end the turn.
- **`resumable: true`** means the agent process was still running when the
  failure was answered, and the next `session/prompt` in this session continues
  the same conversation. If the agent exits after that answer, the retry fails
  with `error.data.code: 'session_exited'`. Then `session/load` the session to
  keep the conversation.
  Everything before the failed turn is kept, and so is any tool work the failed
  turn finished. It is `false` once the session's agent has gone; that session
  fails the next prompt, so `session/load` it or start a new one. When it is
  absent, nothing is claimed.
- **Whether the failed prompt is still in the conversation depends on the
  CLI.** Claude Code drops a prompt that failed before any output, and keeps it
  once the turn did work. Codex always keeps it. Resending the prompt is right
  in every case. At worst the model sees the prompt twice.

`providerMessage` is Codex's own `TurnError.message`, for example why a
`cyberPolicy` stop happened. `providerDetails` holds only these fields when
Codex sent them: `additionalDetails`, `httpStatusCode`, `turnKind`,
`misalignmentErrorType` and `misalignmentExplanation`. Only strings and safe
integers are kept; anything else is dropped. A misalignment block's `steer` and
`reviewTarget` are never forwarded, and neither is the raw frame.

**Both fields are untrusted provider text.** Each string is limited to
`MAX_PROVIDER_TEXT_CHARS` (2048) UTF-16 code units, with `PROVIDER_TEXT_TRUNCATED`
(`…[truncated]`) appended when cut. Hidden and control characters are shown as
`<U+XXXX>` instead of passed through (`markVisible`): C0 controls other than tab
and line feed, DEL, C1 controls, bidi and zero-width format characters,
variation selectors and lone surrogates. In API-key mode, the key the
app-server was logged in with is replaced with `[redacted]` before the text is
marked and cut, in case the provider echoes it. Act on `reason` and `kind`, which
never come from the message. Show the message to a person as quoted provider
text, never as an instruction. A field is absent when the provider sent nothing.

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

## Native commands and file edits

Codex CLI 0.167.0 sessions emit `available_commands_update` in the same shape as
Claude, offering `compact` and `review`. These are measured App Server operations,
not discovery of the full TUI catalog. `META_COMMAND_CATALOG` marks that catalog
as incomplete; other CLI versions and `nativeTools: 'none'` report `null`.

After `await driver.ready`, call `await driver.runCommand('compact')` or
`await driver.runCommand('review')`. Acceptance resolves that promise; native
completion still arrives through `onTurnEnd`. Review assesses uncommitted changes
in the same thread. `prompt()` and ACP `session/prompt` intercept only an exact,
whole, text-only `/compact` or `/review`, with optional surrounding whitespace.
Every other prompt reaches the model unchanged, including `/unknown`,
`/etc/hosts looks wrong`, extra text and mixed image/resource content, as in 0.38.
Hosts decide how to interpret unadvertised slash text.

The explicit `runCommand(name)` API accepts only the advertised operation names.
Unknown names, unavailable methods, a busy session and other refusals raise
`CommandUnsupported` with `code: 'command_unsupported'` and a fixed `reason`.
ACP reports an exact native command's refusal as invalid-request-parameter error
data. Native command execution never falls back to model emulation or a host shell
command.
Cancellation uses the native turn once its ID is known. A lost or malformed
acknowledgement or an unexpected native error closes the session because execution
may have begun.

Codex tool updates use `name: 'shell'` for native command execution,
`name: '<server>.<tool>'` for MCP calls and `name: 'edit'` for file changes.
`META_NATIVE_ITEM_TYPE` and `META_NATIVE_ITEM` retain the native type and a
detached native item snapshot. These values contain the session's tool data;
applications decide where to store or display it. Missing native MCP server or
tool names are not filled with guesses. Live and replayed items share this mapping.

`_meta[META_FILE_EDITS]` (`particle.academy/file_edits`) carries the exported
`readonly FileEdit[]` type:

```ts
interface FileEdit {
  readonly path: string; // workspace-relative, forward slashes
  readonly movePath?: string; // rename destination; path remains the source
  readonly kind: 'add' | 'delete' | 'update';
  readonly newText?: string;
  readonly oldText?: string;
  readonly diff: string;
  readonly textScope: 'file' | 'fragment';
}
```

Codex additions include the full `newText`; deletions include the full `oldText`.
Updates include only native hunks with standard unified headers, without invented
old/new bodies. A rename keeps `path` as the source and adds `movePath` as its
workspace-relative destination; a pure rename has no content hunk. Claude omits
`movePath`. Headers use `--- a/path` and `+++ b/path`, with `/dev/null` on
the absent side of additions/deletions. Native moves use `diff --git`, `rename from`,
`rename to`, `--- a/path` and `+++ b/movePath` headers. Codex's display footer is
removed only when it exactly names the validated native `move_path`; other trailing
text withholds the normalized edit list.
Empty files use Git's regular-file mode marker; native events do not supply
original permissions, so this data does not promise permission restoration.
Unrepresentable paths or patches stay in `rawInput` and native metadata with a
diagnostic; they do not become a false empty edit list. The mapper never reads
the workspace to reconstruct content.
Edit metadata on a pending or failed tool describes the native proposed change;
it is not proof the edit was applied. Check the tool's status and native outcome
before offering a revert.

The additive metadata has a frame budget under the 64,000,000-byte transport cap,
with 4 KiB reserved for the enclosing notification. If it does not fit, the debug
`native_item` copy is omitted first; `file_edits` is omitted only if necessary
after that. Existing tool fields, the native type and name are preserved. Nothing
is truncated and an omitted edit list is never replaced with `[]`.
`_meta[META_OMITTED]` (`particle.academy/omitted`) reports
`{ native_item?: 'frame_budget', file_edits?: 'frame_budget', frameBytes }`.
`frameBytes` counts the encoded update's UTF-8 bytes before omission, excluding
the surrounding ACP envelope. Genie should display **diff unavailable (too large)**
when `file_edits` is marked, rather than reporting no changes.

At the cap edge, even the new name, native type and inline marker may not fit.
The driver then sends the tool row exactly as 0.38 did, followed immediately by a
small debug `notice` on the existing notice channel. Its `META_OMITTED` value is
`{ toolCallId, fields: ['name', 'native_type', 'native_item', 'file_edits'],
reason: 'frame_budget', frameBytes }`. `frameBytes` counts the candidate update
after the ordered payload omissions. Genie should display **too large to describe**
for that row. The notice never contains tool payloads; malformed identifiers over
200 code units become `null`. Claude's notice lists only `file_edits`, its additive
field. An already oversized legacy frame retains the legacy framing rejection.

Claude `Edit` and `MultiEdit` share this type: `file_path`, `old_string` and
`new_string` supply exact replacement fragments, marked `textScope: 'fragment'`.
Their diff coordinates are fragment-relative and do not identify the fragment's
position in the complete file. A standalone `ClaudeToAcp` mapper needs its optional
workspace argument to project edits; `ClaudeDriver` supplies it automatically.

Genie can count added/removed lines from `diff`. Whole-file Codex update bodies
are unavailable: revert uses reverse-applied hunks, after `git apply -R --check`
confirms they still apply cleanly. Measured native updates supplied zero context
at a file edge and one line on each side of a middle edit; there is no three-line
context guarantee. Modified or ambiguous files and Claude fragment-only diffs may
fail that check. Refuse an unsafe revert rather than reconstructing guessed text.

## Steering a running Codex turn

`CodexDriver.steer(content, { clientId, expectedTurnId? })` explicitly adds input to the active native turn through
`turn/steer`. `content` accepts the same text/image/text-resource blocks as `prompt()`. Ordinary `prompt()` and ACP
`session/prompt` continue to refuse a second in-flight turn. Steering never queues for startup or a future turn,
retargets, retries, starts another turn, changes model/tools/configuration, or grants a pending permission.

`CODEX_DRIVER_CAPABILITIES.steer` advertises the API. `driver.steeringState` reports `supported`, `cliVersion`,
`activeTurnId`, `retainedRecords` and `capacity: 128`. Support requires a completed handshake with stable Codex
>=0.163.0; a missing native method disables it. Unsupported calls throw exported `SteerUnsupported` with
`code: 'steer_unsupported'`. The independent, exact CLI/model restrictions for `nativeTools: 'none'` are unchanged.

Before sending, the **host must durably retain the fresh UUID, target turn and original input** in its own transcript
or outbox. The package retains metadata only, without a persistent outbox. For example, with the host's existing
`outbox` and a running `driver`:

```ts
const clientId = crypto.randomUUID();
const expectedTurnId = driver.steeringState.activeTurnId;
if (expectedTurnId === null) throw new Error('No known active turn');
await outbox.save({ clientId, expectedTurnId, content });
const acceptance = await driver.steer(content, { clientId, expectedTurnId });
// Keep the saved input pending until a matching observation or an explicit host decision.
```

Always supply `expectedTurnId` when targeting a previously displayed turn; the optional direct-call default pins the
current turn at the call itself. The reply reports native `accepted`, definite pre-send/native-validation
`not_delivered`, or `unknown`. A 30-second reply deadline, ambiguous write, malformed reply or other native error is
`unknown`, never a reason for an automatic retry. Unsupported/invalid UUID errors are typed and contain fixed text.
Other local refusals, including a stale target, cancellation, duplicate UUID or capacity, send nothing.

`onSteerUpdate` and namespaced `_meta['particle.academy/steer']` updates report each native attempt. Retrieve the
retained immutable record with `driver.steerState(clientId)`, including after a missed callback:

| Record `kind` | Meaning |
|---|---|
| `accepted` | Native RPC accepted input; its appearance is still pending. |
| `observed` | A live native user item has the exact `item.clientId`, owning thread and target turn. This does not prove obedience or semantic application. |
| `turn_ended_unobserved` | Native completed/interrupted/failed turn and buffered frames drained without an observed matching item on a healthy stream. **Final.** Absence of observation does not prove no inference consumed the input. |
| `not_delivered` | Native method/known validation refusal establishes no accepted send. Local refusals return directly without allocating a record. |
| `unknown` | Native acceptance or item correlation is uncertain. Retain the original input for a deliberate host decision. |

Each record keeps RPC `acceptance` separately, including `pending` when a matching item arrives before the reply.
Unknown state can gain an exact live observation; a final `turn_ended_unobserved` is never changed to `observed`.
A later match emits the separate `late_item_after_final` anomaly with the operation and native item IDs. A stream gap,
missing correlation or conflicting native item IDs cannot justify a precise absence claim. Text, counts and arrival
order are never used to match input. History replay cannot confirm a new send.

After durably handling a final record **and its settled RPC acceptance**, call `driver.acknowledgeSteer(clientId)`.
It returns false for pending/unknown IDs. At 128 unacknowledged records, new steering is refused before writing;
acknowledgement frees capacity without evicting another record. Session shutdown surfaces remaining uncertainty
before releasing that session's records. `steerState()` in a new driver process returns `{ kind: 'not_known' }`;
resumed-history reconciliation is unmeasured and not implemented. The package does not promise exactly-once
delivery. A repeated native client ID creates duplicate user items; this driver refuses reuse within its session,
including after acknowledgement. Callers still need fresh IDs and their own durable input lifecycle.

ACP exposes these **nonstandard namespaced extensions**:

- `_particle.academy/session/steer`: `{ sessionId, clientId, expectedTurnId, prompt }`, where `prompt` is the ordinary
  ACP content-block array. `expectedTurnId` is required. Returns acceptance only.
- `_particle.academy/session/steer_state`: `{ sessionId, clientId }` for a retained record, or `{ sessionId }` for
  runtime support/current-turn state.
- `_particle.academy/session/acknowledge_steer`: `{ sessionId, clientId }`, returns `{ acknowledged: boolean }`.

The server resolves the native thread from its owned session; a caller-supplied `threadId` is refused. Active turn
identity is published through `_meta['particle.academy/active_turn']` on `session/update`. Claude and drivers without
an explicit steering API do not claim this capability. PHP/Python steering parity is a separate follow-up.

Native Codex 0.167.0 / gpt-6.1-sol was remeasured with the CLI's own ChatGPT login: steering accepted while a controlled
host tool was held, with no agent delta until its release, and repeated native IDs produced distinct user items.
Separate 0.167.0 approval measurements, without experimental API negotiation, observed exact client IDs after approval
was declined, while interruption left accepted inputs unobserved. These agree with the earlier 0.163.0 measurements.
An input refused after cancellation is `not_delivered`; an accepted but unseen input
uses the final unobserved/unknown rules above. No approval was granted and no credential was read or copied.

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
  "request": { "subtype": "interrupt", "cancel_queued": true } }` to the CLI's stream-json stdin.
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
  - **Queued notices are cancelled too.** Claude Code 2.1.318 was measured on
    2026-11-05 through `ClaudeDriver.prompt()` and `cancel()`, the direct entry
    embedders use. Without `cancel_queued`, a notice written during a turn ran
    after Stop. With it, the CLI dropped the notice without emitting a result.
    Each prompt now has a fresh UUID: receipt-listed UUIDs end locally with
    `cancelled`; the active prompt ends through its own result. Callbacks keep
    submission order. A new prompt written after cancel can still run normally.
    Lifecycle metadata is consumed silently and only corroborates the receipt.
    Repeated or idle cancel sends no extra interrupt. A missing receipt (30s
    control deadline) or inconsistent accounting ends every unfinished prompt
    with the fixed raw marker `cancel accounting mismatch` and stops the uncertain
    process. The host receives `onProtocolError` with the fixed reason
    `cancel state uncertain; driver stopped`; later `prompt()` calls throw the
    exported `ClaudeCancelStateError` (`code: 'claude_cancel_state_uncertain'`)
    with the same reason. Start a new driver afterwards. Older serial CLI
    results that omit UUIDs remain supported.
    ACP itself continues to allow one turn per session.

    `ClaudeCancelStateError.stopVerdict` is an immutable snapshot of native
    cleanup facts at the time the error is thrown. Until cleanup settles it
    reports `{ graceful: false, empty: false, survivors: null, verified: false }`.
    This means unknown; it does not establish that a process survived. The
    immediate `onProtocolError` notification still precedes cleanup. Observe
    `onStopVerdict` for the eventual result rather than relying on an early error.
  - **Folded prompts settle (G-266).** Claude Code can fold a prompt written
    while a turn runs into that turn. The folded prompt then gets no result of
    its own. Measured on Claude Code 2.1.325 with `npm run probe:claude-fold`
    (after `npm run build`): the folded prompt is queued and then started
    inside the running turn, and that turn's result lists both prompts in
    `user_message_uuids`.
    - `ClaudeDriver.prompt()` returns the prompt's turn id. Every
      ClaudeDriver outcome carries it as `turnId`.
    - A folded prompt ends with the joined turn's outcome plus
      `foldedInto: <turnId of the turn it joined>`.
    - The driver decides this only from the result's list, never from a
      timeout. Ids that are not your prompts settle nothing. A list that omits
      its own prompt is reported through `onProtocolError` and folds nothing.
    - Measured on the same version: a cancel during a fold gets a receipt that
      names neither prompt, and the interrupted result lists both. Both prompts
      end `cancelled` and the CLI stays up. If that result leaves a started
      prompt unaccounted for, the driver fails closed, as for any cancel
      accounting mismatch.
  - **Unsolicited turn ends (G-313).** Claude Code sometimes starts a turn on
    its own, for example when a background task the agent started (such as
    `gh run watch`) finishes after the previous turn ended. That turn streams
    output and then ends with a result that names none of your prompts.
    - `onTurnEnd` fires for it with `unsolicited: true`, no `turnId`, and a
      driver-generated `unsolicitedTurnId`. It carries the stop reason and
      failure like any other outcome, and its usage arrives first as a
      `usage_update`.
    - A prompt you write while that turn runs can be folded into it. It then
      ends with `foldedInto: <unsolicitedTurnId>`, under the same rules as
      any fold. Later turn ends are not held behind it.
    - Only a LIVE turn ends this way: model output (a streamed delta, or an
      assistant message not marked as a replay) must arrive after the last
      result while no prompt of yours is in flight. A result with no such
      output before it, including one replayed on resume, is dropped as
      before. A result that names one of your prompts is always that
      prompt's.
    - The ACP agent does not answer a pending `session/prompt` with an
      unsolicited end. A direct embedder should not either: check
      `outcome.unsolicited` before matching an outcome to a prompt.

Once a client has cancelled, the prompt is answered `cancelled` even if the turn
finished or failed in the race with the interrupt, as ACP requires. If the
interrupt itself is refused, the agent is stopped instead, so Stop always stops.
A driver an embedder writes without `cancel()` gets that same stop.
A cancel with no turn in flight does nothing. Closing the connection still stops
every agent.

## Liveness: is the agent stalled or just busy?

A turn that has gone quiet may be thinking, running a long tool, or stuck. Both drivers give a host what it needs to
tell those apart and offer Stop/Restart only when the agent really stopped answering:

```ts
const alive = await driver.ping({ timeoutMs: 5_000 }); // true: the agent answered; false: it did not
driver.lastFrameAt;                                     // epoch ms of the agent's last stdout frame; undefined before the first
driver.running;                                         // the agent process has been spawned and has not exited
```

- **`ping()` never rejects.** It resolves `true` when the agent answered a harmless read-only request -- an error
  answer counts, because the agent read and processed it -- and `false` when it did not answer within the timeout, when
  the request could not be written, when the process exited first, or when the driver is not started or is stopping.
- **It touches nothing.** Claude is sent the control protocol's `mcp_status` request, the one the Agent SDK's own
  `mcpServerStatus()` sends; Codex is sent `model/list`, the request `modelState()` already uses. Neither writes a user
  message, starts, steers, interrupts or joins a turn, or changes session state, and it is safe mid-turn: a turn's
  outcome, updates and usage are the same with or without a ping. The answer is matched by its request id only.
- **It is bounded.** `timeoutMs` is clamped to 100..60000 ms (default 5000). Concurrent calls share one ping, and its
  first caller's timeout. A ping that timed out leaves its one request outstanding, and the next ping waits on that same
  request rather than sending another, so a stalled agent is never sent a growing queue of probes.
- **`lastFrameAt` counts only frames from the agent** that parse. Writing a ping never moves it; the agent's ANSWER to a
  ping is a frame, so an answered ping does.
- **`running`** is the same on both drivers: true from `start()` until the process exits, across every turn. `stop()`
  and `kill()` do not clear it themselves; the exit does.

A host can combine them: if `lastFrameAt` is old and a ping comes back `false`, the agent is not answering, and Stop or
Restart is the honest offer.

## Ending a session ends every process it started

Each CLI runs under a small supervisor that owns its whole process tree -- the CLI, its MCP servers, the shells and tool
subprocesses they start, `detached` ones included -- and never through a shell:

- **Windows:** the CLI is created suspended inside a Job Object (`KILL_ON_JOB_CLOSE`, no breakaway) before it runs a
  single instruction. The supervisor is built once per install with the `csc.exe` of .NET Framework 4, into
  `%LOCALAPPDATA%/prism-acp/supervisor-<source hash>/`, and its SHA-256 is checked before every launch. If it cannot be
  built or verified the driver refuses to start, naming the cause, rather than run uncontained. Call
  `prepareProcessTree({ directory? })` at startup so that surfaces once, before the first session.
  Concurrent first launches publish hash-named executables without replacing existing files, then atomically
  rename a temporary current-hash pointer in the same directory. Readers bind that digest to the executable's
  name and verify its bytes before using it. This avoids mixing one compiler's executable with another's hash;
  a genuinely altered cache is rebuilt once or refused. Old generations remain available to running sessions.
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

Both drivers accept an optional `onStopVerdict(verdict)` event. It receives an
immutable copy of the native facts once the idempotent `stop()` settles, including
Claude's automatic stop after uncertain cancellation. Repeated calls share that
stop and emit once; the first call's stop options apply. A throwing or rejecting
observer is isolated and cannot change the verdict or delay cleanup. `kill()`
does not wait for or publish a verdict.

The ACP host can observe the same result through
`AcpAgentOptions.onStopVerdict(sessionId, verdict)`. This is a host callback with
the owning session ID; it adds no ACP method or notification. `StopVerdict` is
exported from the package root. Preserve `verified: false` and a null survivor
count when the supervisor could not report, including custom Codex transports
without `stop()`. Even `empty: true` can accompany an unverified count; do not
turn that into observed zero survivors. Direct Codex interrupt refusal still
rejects without stopping its running driver; explicitly call `stop()` when the
host intends to end that driver.

Version 0.40.0 adds observability only. No tree-kill defect was reproduced in the
native uncertain-cancel measurements; supervision, stop grace, interrupt timing
and existing callback ordering are unchanged.

`kill()` ends the tree too, without waiting to report. On Windows a `.cmd` is run only if it is an npm shim (as node +
its script), and the current directory is never searched for the binary. To run a script as the provider, name the
interpreter and pass the script first: `{ binary: process.execPath, binaryArgs: ['/abs/stub.mjs'] }`.

### Windows AppContainer transport

For a host running inside an AppContainer, opt into `windowsStdio: 'local-pipes'`.
This uses authenticated `\\.\pipe\LOCAL\` endpoints for control and provider byte
I/O. The existing Windows supervisor creates them with protected explicit ACLs
granting only the launching user and its AppContainer SID (when present), then
Node connects. A per-launch secret and nonce-bound mutual HMAC authenticate both
ends before any launch specification or provider bytes are accepted. It keeps
the suspended launch, Job Object containment and host-death cleanup.
It requires no loopback exemption or network capability. The default transport
for ordinary Windows hosts is unchanged.

The embedding application creates the AppContainer and grants its profile SID
access to the trusted executables, package files, supervisor directory and
assigned writable workspace/home. Build the supervisor with
`prepareProcessTree({ directory })` before entering the AppContainer, then make
its directory read-only to the contained processes. Call the same preparation
method in the worker to verify that prepared copy. A missing or changed copy is
refused if it cannot be rebuilt; there is no uncontained fallback.

```ts
import { childEnv, launchProvider, prepareProcessTree } from '@particle-academy/prism-acp';

// Paths, trusted command/arguments and byte handlers are supplied by the application.
await prepareProcessTree({ directory: assignedSupervisorDirectory });
const { env } = childEnv(process.env);
const provider = launchProvider(trustedExecutable, trustedArguments, {
  cwd: assignedWorkspace,
  env,
  windowsStdio: 'local-pipes',
  startupTimeoutMs: 5_000,
});
const io = provider.io!;
io.stdout.on('data', onProviderBytes);
io.stderr.on('data', onProviderDiagnosticBytes);
await provider.started;
// Respect io.stdin.write()'s return value and wait for 'drain' when it is false.
const verdict = await provider.stop({ graceMs: 1_000 });
```

In this mode `provider.child` is the real supervisor process; use `provider.io`
for provider streams. Its unused native bootstrap handles reference its own
executable opened read-only, avoiding both global stdio pipes and NUL opens
(which some restricted Windows hosts also deny). No host stdio or writable file
is inherited for bootstrap. `provider.closed` resolves after
the supervisor ends and output drains, with a five-second drain bound. Byte
streams use 64 KiB watermarks and standard Node backpressure; writers must honor
`write()` returning `false`. Authentication has bounded headers and a deadline.
`startupTimeoutMs` applies to the local transport's handshake/provider startup,
defaults to 10 seconds and accepts integer values from 1 to 60,000 ms. Native
connect/authentication is additionally capped at five seconds per channel.
`ioTimeoutMs` bounds a pending stdin write or blocked output backpressure,
defaults to 30 seconds and accepts the same range; idle sessions are allowed.
Both deadline options require LOCAL mode. LOCAL mode is rejected on non-Windows
platforms. Resolve
trusted binaries and prepare the supervisor before a time-sensitive session;
the deadline does not interrupt synchronous compilation or filesystem access.

API-key homes must already exist with application-provisioned container ACLs;
LOCAL mode refuses to create them through the ordinary Windows ACL helper.
Claude accepts generated `mcpServers` in LOCAL mode with `nativeTools: 'none'`
as described above. Other generated Claude MCP configuration, `disabledMcpServers`
and `permissionPrompts` still refuse in LOCAL mode; their ordinary ACL/approval
paths require a separate AppContainer-compatible implementation.

Both drivers and `listModels()` accept the same configuration through
`processTree`. Their protocol I/O uses the selected transport automatically:

```ts
import { ClaudeDriver, CodexDriver, listModels } from '@particle-academy/prism-acp';

const processTree = { windowsStdio: 'local-pipes' as const, startupTimeoutMs: 5_000 };
new ClaudeDriver({ cwd: assignedWorkspace, processTree });
new CodexDriver({ cwd: assignedWorkspace, processTree });
await listModels('codex', { cwd: assignedWorkspace, processTree });
```

This option covers Prism's launch and protocol I/O. The application still owns
sandbox provisioning, ACLs, networking, credential/profile storage and validation
of the real CLI and any processes it starts. A CLI that creates incompatible IPC
itself needs its own compatibility fix. Package tests exercise trusted fixture
executables inside real AppContainers without credentials or model calls. The
separate pinned native Claude lane uses an explicit fake key for startup and
stdio MCP discovery, with no authenticated model turn.
On Windows run that fixture explicitly with `PRISM_ACP_APPCONTAINER=1` and
`npx vitest run test/appcontainer.test.ts` after building. Windows CI opts in;
other platforms and ordinary test runs visibly skip OS-profile creation.

The worker must already be able to load Node and the package from its assigned
paths. Tests stage physical paths and use Node's `--preserve-symlinks` and
`--preserve-symlinks-main` flags to avoid a `realpath` walk through denied parent
directories. No drive-root or machine-wide file grant is added by the package.

## Driver capabilities

When the embedder identifies the selected driver, `initialize` declares its
measured behavior in `_meta` under
`particle.academy/driver_capabilities`. The object carries
`permissionRequests`, `transcriptReplay`, `mcpCapabilities`, `promptBlocks`,
`cancel` (whether `session/cancel` keeps the session; label Stop from it) and
`loadSession`. If the key is absent, capabilities
were not declared; absence does not mean `false`. Claude's exported default has
`permissionRequests: false`; a host that enables its optional permission hook
declares the configured capability through `serve` as described above. Read the
runtime declaration rather than caching capabilities against a provider name.

### Writing a driver outside this package

`AcpAgent` fronts any `AgentDriver`. Two parts of the contract are exported so a
driver does not copy them:

- **Resume.** Declare `loadSession: false` in the `driverCapabilities` you pass
  to `AcpAgent` or `serve` when your sessions cannot be resumed. `initialize`
  then advertises `agentCapabilities.loadSession: false`, and `session/load` is
  refused with a method-not-found error before your factory is called. Absent
  means `true`; the Claude and Codex declarations say `true`.
- **Permission decisions.** `permissionDecision(request, outcome)` returns
  `{ allow, reason }`. It allows only when the client selected an option the
  request offered, matched exactly, whose kind is `allow_once`. Anything else is
  a denial: an option that was not offered, a look-alike id, an id offered twice,
  a cancel, a malformed answer. `askPermission(events.onRequestPermission,
  request)` asks and decides in one step, and also denies when the client throws
  or there is no client to ask. `ALLOW_ONCE_OR_DENY` is the frozen option list
  the Claude driver offers. The Codex driver does not use this rule: it offers
  Codex's own options, including "Allow for this session" (`allow_always`), and
  maps each offered id to Codex's answer exactly. This rule denies
  `allow_always`.
- **Plan text.** The gate checks a plan's shape and size, not its words, and
  entry `content` is shown next to the host's `(you)` and `[failed]` labels.
  Pass model-written step text through `planTitle` (or project the plan with
  `planUpdate`, which does): it always puts `Step: ` in front, so only labels
  your driver adds from its own state come before it. Clean a markdown plan's
  content yourself.

```ts
import { ALLOW_ONCE_OR_DENY, askPermission } from '@particle-academy/prism-acp';

const decision = await askPermission(events.onRequestPermission, {
  toolCall: { toolCallId, title, rawInput },
  options: ALLOW_ONCE_OR_DENY,
});
if (!decision.allow) return refuse(decision.reason);
```

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
the path. It does not inspect a credential filename. Codex tests use temporary
working directories with a read-only sandbox. They require assistant text and
successful completion, memory across a second turn, and history replay and
memory after a fresh-process resume. They also exercise a live Codex
turn cancel: `turn/interrupt` accepted, the turn's raw status `interrupted`, the
app-server neither closed nor exited, and the next prompt reaching `end_turn`.

## License

MIT
