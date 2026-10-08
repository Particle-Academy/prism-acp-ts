// Does a CLI session id name a conversation that exists?
//
// `session/load` used to answer this by trying. It spawned the agent with
// `--resume <id>` and the CLI's refusal -- `No conversation found with session
// ID: <id>` -- arrived when the FIRST PROMPT ran, by which point `session/load`
// had already returned success and the client believed it held a resumed
// session. The failure was real but indistinguishable from any other late
// error, and a consumer reported it as the only thing standing between a bad id
// and a lost conversation.
//
// WHY NOT PROBE WITH THE CLI. The obvious probe is
// `claude --resume <id> -p x`, which does refuse a bad id for free. On a GOOD
// id it resumes the conversation and answers "x" -- a real turn, real tokens,
// on every successful load. A probe that costs a turn on the happy path is
// worse than the problem it solves.
//
// So this reads the session store instead, which costs a directory listing.
//
// WHY SCAN RATHER THAN DERIVE THE PATH. Sessions live at
// `~/.claude/projects/<slug>/<uuid>.jsonl`, where `<slug>` is the project's cwd
// with its separators and punctuation replaced by `-`. Deriving that slug means
// reimplementing an undocumented rule, and getting it wrong would mean looking
// in a directory that does not exist and calling a VALID session absent --
// refusing a resume that would have worked, which is a worse failure than the
// late error this replaces. A session id is a UUID and therefore unique across
// every project, so looking for the FILE is enough and needs no slug at all.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Three states, and the third is the point.
 *
 * `indeterminate` means the store could not be read -- a different CLI version,
 * a relocated home, a permissions problem, a layout change. It must never be
 * treated as `absent`: this check exists to turn a late failure into an early
 * one, and it is not worth refusing a resume that would have worked.
 */
export type SessionExistence = 'present' | 'absent' | 'indeterminate';

export interface SessionProbe {
  readonly existence: SessionExistence;
  /** Why, in terms a client can act on. Empty for `present`. */
  readonly detail: string;
}

/** The CLI accepts a UUID, or a session TITLE, and nothing else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionStoreOptions {
  /** Overridable so tests never read the developer's real sessions. */
  readonly home?: string;
  /**
   * The CLI's configuration home, naming the store directly. Outranks both
   * {@link home} and the environment -- for a caller that knows where the store
   * is, or that builds the driven CLI's environment itself.
   */
  readonly configDir?: string;
  /**
   * The environment the DRIVEN CLI will see, read for `CLAUDE_CONFIG_DIR`.
   *
   * Defaults to this process's own, which is correct by construction when the
   * driver is spawned from here: `childEnv` passes `CLAUDE_CONFIG_DIR` through
   * unchanged, so the probe and the child resolve one store. Hand the driver a
   * `parentEnv` of your own and hand the same one here, or they will not.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * WHERE THE STORE IS. The CLI resolves its configuration home as
 * `CLAUDE_CONFIG_DIR` or, unset, `<home>/.claude`, and keeps `projects` under
 * whichever it picked.
 *
 * Reading only the second was this probe's one serious bug (0.4.0). An
 * installation that sets the variable -- Genie forwards it deliberately,
 * because the stored subscription credential lives there and is what lets a
 * child run with no API key at all -- had the probe read a store the CLI does
 * not use, find nothing, and report `absent` for a conversation that exists.
 * That refuses a resume that would have worked: the failure this whole
 * three-state design exists to avoid, reintroduced by the check meant to
 * prevent it.
 *
 * The variable names the configuration home ITSELF, so `projects` sits directly
 * inside it and no `.claude` is appended. Resolving it as
 * `home: dirname(CLAUDE_CONFIG_DIR)` instead would work only while the
 * directory happens to be named `.claude`.
 */
function storeRoot(options: SessionStoreOptions): { readonly root: string } | { readonly reason: string } {
  const configured = options.configDir ?? (options.env ?? process.env).CLAUDE_CONFIG_DIR;
  const trimmed = configured?.trim();

  // The CLI reads it with `||`, so an empty or blank value is no value. Taking
  // it literally would resolve `projects` against this process's working
  // directory.
  if (trimmed === undefined || trimmed === '') {
    return { root: join(options.home ?? homedir(), '.claude', 'projects') };
  }

  // The CLI refuses to run at all with a relative configuration home -- "the
  // configuration home (CLAUDE_CONFIG_DIR) is not an absolute path" -- so there
  // is no store to name, and resolving it against our own cwd would answer
  // about a directory the CLI never looks in. It is also not a case for the
  // `<home>/.claude` fallback: the CLI will not fall back either.
  if (!isAbsolute(trimmed)) {
    // The value itself stays out of the message. Every other `detail` here
    // names the path it looked at, which is useful and harmless for a path we
    // derived; this one is an environment value, and a detail string travels to
    // the client.
    return { reason: 'CLAUDE_CONFIG_DIR is not an absolute path, so the session store it names cannot be located' };
  }

  return { root: join(trimmed, 'projects') };
}

export function probeSessionStore(sessionId: string, options: SessionStoreOptions = {}): SessionProbe {
  // A non-UUID is refused by the CLI outright -- verified against claude
  // 2.1.292: "Provided value ... is not a UUID and does not match any session
  // title." Reported as absent without touching the disk, because the store
  // cannot contain it under any layout.
  //
  // This is narrower than it looks: the CLI also accepts a session TITLE, and a
  // title is not a UUID. It is reported absent anyway, because this server
  // publishes the CLI's UUID as the thing to resume with and a client passing a
  // human-chosen title is working from something else.
  if (!UUID.test(sessionId)) {
    return {
      existence: 'absent',
      detail: `${sessionId} is not a session id the CLI can resume: it is not a UUID.`,
    };
  }

  const resolved = storeRoot(options);
  if ('reason' in resolved) return { existence: 'indeterminate', detail: resolved.reason };
  const { root } = resolved;

  let projects: readonly string[];
  try {
    if (!statSync(root).isDirectory()) {
      return { existence: 'indeterminate', detail: `${root} is not a directory` };
    }
    projects = readdirSync(root);
  } catch (error) {
    return { existence: 'indeterminate', detail: `${root} could not be read: ${(error as Error).message}` };
  }

  // An EMPTY store is indeterminate rather than absent. A store with no
  // projects in it is far more likely to be the wrong store than a genuine
  // record that this conversation never existed.
  if (projects.length === 0) {
    return { existence: 'indeterminate', detail: `${root} lists no projects` };
  }

  const wanted = `${sessionId}.jsonl`;
  let readable = 0;
  for (const project of projects) {
    let entries: readonly string[];
    try {
      entries = readdirSync(join(root, project));
    } catch {
      continue; // One unreadable project does not settle the question.
    }
    readable++;
    if (entries.includes(wanted)) return { existence: 'present', detail: '' };
  }

  // Every project directory failed to open. Absence has not been established.
  if (readable === 0) {
    return { existence: 'indeterminate', detail: `no project directory under ${root} could be read` };
  }

  return {
    existence: 'absent',
    detail: `no conversation with session id ${sessionId} exists in this installation's session store.`,
  };
}
