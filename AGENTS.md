# AGENTS.md — prism-acp-ts

An Agent Client Protocol implementation that drives a coding-agent CLI the user
has already authenticated. Read the shared agent guide in
`prism-parity/docs/AGENTS.md` first: the boundary, the satellite map, the rules
that bind, and the review skills.

**This is not a port.** Every other satellite here mirrors a reference package
in `particle-academy/*`. This one has no upstream reference — it is a
Prism-originated family, decided 2026-10-05, and the design record is the
envelope's `.ai/plans/prism-agent-transport.md`. Read that before changing
anything load-bearing; it carries the measurements the decisions rest on and the
places where a correct-looking mapping would destroy information.

## Gates — run them on EXIT CODES

```sh
npm run typecheck
npm run build
npx vitest run
```

Never pipe a gate into `head`/`tail`/`grep` and read `$?` — that is the
FILTER's exit code, not the gate's. Redirect to a file, echo `$?`, then look.
This has already produced a false green here: an `npm install` that failed with
`Cannot read properties of null` reported exit 0 through a pipe, and the suite
then ran against an ad-hoc vitest instead of the pinned one.

## The live proof — opt-in, and why it injects its own bad key

```sh
npm run test:live     # spawns `claude` twice; costs a little subscription usage
```

Two controls against the real binary:

- **negative** — a bogus `ANTHROPIC_API_KEY` passed *through* must be **used and
  rejected `401`**;
- **positive** — the same key **stripped** must let the call succeed on the
  user's own login.

The negative one is load-bearing. Without it, an `env` builder that returned an
empty object would satisfy the positive half completely.

It injects the bad key rather than using the machine's, deliberately. The hazard
was first seen because a workstation happened to carry an invalid key — and a
test written against that condition would pass only while a workstation stayed
misconfigured, then silently stop testing anything once someone fixed it. **A
guard that works only while the environment is broken is not a guard.**

It also asserts the 401 rather than a non-zero exit, because measuring showed
why: with a rejected credential the CLI does not fail, it **retries ten times
with backoff and runs past three minutes**. The first version of this test timed
out instead of failing, which reads as a broken test rather than as the
behaviour it exists to pin. Watching for the auth rejection is faster and
asserts the mechanism — the key reached the child and outranked the login — which
a bare non-zero exit cannot distinguish from any other failure.

On Windows the `test:live` script's `VAR=1 cmd` prefix is POSIX-only; run it
from a POSIX shell. If the flag is absent the suite **skips** rather than passes,
so a wrong invocation cannot read as a green result.

## What this package holds

The trust boundary is the **credential**, and it is unusual: this package's job
is to make sure a credential it never reads does not reach the child it spawns.

- `env.ts` — the child environment, built **allow-list-first**. The hazard is
  that these CLIs resolve credentials from an ORDERED list with
  `ANTHROPIC_API_KEY` first, so an inherited key does not lose to the user's
  subscription, it OUTRANKS it. A valid one bills per token while the interface
  says "subscription"; an invalid one 401s and retries to exhaustion without
  ever falling back, because precedence is resolved before validity is tested.
- `ndjson.ts` — framing, with three decisions pinned across all three languages
  rather than left to each one's JSON parser.

## The rules that bind this package

**An allow-list, never a deny-list.** A deny-list naming today's credential
variables is one new provider variable away from being wrong again, in the
direction that spends money silently. An allow-list is wrong in the direction
that fails loudly. When a guard can err two ways, take the one that produces an
error over the one that produces a plausible result.

**Compare environment names case-INSENSITIVELY.** Windows environment names are
case-insensitive, so `anthropic_api_key` reaches a child exactly as the
conventional spelling does while passing any case-sensitive check. This is the
same shape as the trailing space that defeated `prism-human-plus`'s tool-name
reservation in three languages at once.

**Never mutate the ambient environment.** The surrounding workspace may hold an
API key on purpose; other consumers beside this one legitimately bill per token.
Build the child's environment and leave `process.env` alone. An adapter that
"cleaned" the ambient environment would fix its own call and silently break
every other consumer, wearing the disguise of tidying up.

**Pinned framing values are identical in every port, or they are a bug.** A
trailing `\r` is stripped rather than tolerated; `MAX_LINE_BYTES` is 1,000,000
everywhere; a framing error reports size and never content. A cap that differs
per language means one implementation dies where another succeeds on the same
stream.

**A structurally correct mapping can still be wrong.** Two known instances, both
recorded in the plan: ACP has one permission concept where Codex has five
(`ApplyPatch`, `CommandExecutionRequest`, `ExecCommand`, `FileChange`,
`PermissionsRequest`), and *what* is being decided is exactly what a human needs
in order to decide it. And `signature_delta` is a thinking block's integrity
signature — dropping it must be a written choice, not the silent consequence of
an exhaustive switch nobody noticed was lossy.

**`null` means "cannot see"; `[]` means "none".** Not interchangeable.
Collapsing them is the bug. Codex exposes no slash-command list at all, so
`available_commands_update` reports `null` — reporting `[]` would assert that
the agent offers no commands, which is a different and false claim. The
corollary: never render a dash for an unknown number, because a dash reads as
zero.

**A guard needs a test from both sides.** An env builder that returned `{}` for
everything would satisfy every "the secret did not get through" assertion in
the suite. That is why the positive control — a credential passed through under
the explicitly-named option — is a test and not a comment.

## What is NOT built yet

The JSON-RPC peer, the Claude driver (`claude --print --output-format
stream-json --input-format stream-json`) and the Codex driver (`codex
app-server`). The protocol surface and the captured wire shapes are in the
plan; the Codex protocol is self-documenting via
`codex app-server generate-json-schema`, so regenerate it rather than trusting a
snapshot.
