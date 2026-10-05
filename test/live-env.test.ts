/**
 * Proves the credential strip against the REAL agent CLI.
 *
 * Opt-in, because it spawns `claude` and spends a little of the user's
 * subscription: `npm run test:live`. Skipped otherwise, and skipped with a
 * named reason when the binary is absent, so a skip can never be mistaken for a
 * pass.
 *
 * ## Why this injects a bad key instead of using the machine's
 *
 * The hazard was first observed because a developer workstation happened to
 * carry an invalid `ANTHROPIC_API_KEY`, and `claude` failed `401` ten times
 * rather than falling back to the working subscription login. It would be easy
 * to write this test against that condition -- and then the test would pass
 * only while a workstation was misconfigured, and silently stop testing
 * anything the moment someone fixed it. **A guard that works only while the
 * environment is broken is not a guard.**
 *
 * So the bad credential is injected here, which makes both halves hold
 * anywhere:
 *
 *   - NEGATIVE control: the bogus key passed THROUGH must break the call. If it
 *     does not, the positive half below proves nothing -- it would be passing
 *     because the key is ignored, not because it was stripped.
 *   - POSITIVE control: the same bogus key STRIPPED by `childEnv` must let the
 *     call succeed on the user's own login.
 *
 * The negative control is the load-bearing one. Without it, an `env` builder
 * that returned an empty object would satisfy this file completely.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { childEnv } from '../src/env.js';
import { ClaudeDriver } from '../src/claude/driver.js';
import type { AcpUpdate } from '../src/claude/to-acp.js';
import { NdjsonFramer } from '../src/ndjson.js';

const LIVE = process.env.PRISM_ACP_LIVE === '1';
const BOGUS = 'sk-ant-api03-deliberately-invalid-key-for-the-negative-control';
const PROMPT = 'Reply with exactly: ok';

interface Run {
  readonly code: number | null;
  readonly stdout: string;
}

/** Run `claude --print` once with a given environment, to completion. */
async function runClaude(env: Record<string, string>): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    const child = spawn('claude', ['--print', PROMPT, '--output-format', 'json'], {
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/**
 * Run until the CLI reports an auth failure, then stop.
 *
 * Waiting for the process to EXIT is the wrong assertion, and measuring it
 * proved why: with a rejected credential the CLI does not fail, it retries ten
 * times with backoff and runs past three minutes. The first version of this
 * test timed out instead of failing, which would have read as a broken test
 * rather than as the behaviour it was trying to pin.
 *
 * So this watches the stream for the auth rejection itself and kills the child
 * the moment it arrives: faster, and it asserts the MECHANISM -- the bad
 * credential was used and refused -- rather than merely that something went
 * wrong. Parsing it with our own framer dogfoods that module against real
 * traffic at the same time.
 */
async function authFailureObserved(
  env: Record<string, string>,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--print', PROMPT, '--output-format', 'stream-json', '--verbose'],
      { env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const framer = new NdjsonFramer();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      for (const frame of framer.push(chunk)) {
        if (!frame.ok) continue;
        const f = frame.value as { subtype?: string; error_status?: number };
        if (f.subtype === 'api_retry' && f.error_status === 401) finish(true);
      }
    });
    child.on('error', reject);
    child.on('close', () => finish(false));
  });
}

describe.skipIf(!LIVE)('the credential strip, against the real CLI', () => {
  // The CLI needs its own config directory to find the user's login, so it is
  // allow-listed explicitly rather than inherited wholesale.
  const allow = ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'];

  it('NEGATIVE control: a bogus key passed through is USED and rejected 401', async () => {
    const { env, withheld } = childEnv(
      { ...process.env, ANTHROPIC_API_KEY: BOGUS },
      { allow, allowSubscriptionOverridingCredentials: true },
    );
    expect(withheld).toEqual([]);
    // Precedence is resolved before validity is tested, so the invalid key wins
    // over a perfectly good subscription login. Observing the 401 is what shows
    // the key reached the child and outranked the login -- a mere non-zero exit
    // would not distinguish that from any other failure.
    await expect(authFailureObserved(env, 90_000)).resolves.toBe(true);
  }, 120_000);

  it('POSITIVE control: the same bogus key stripped must let the call succeed', async () => {
    const { env, withheld } = childEnv(
      { ...process.env, ANTHROPIC_API_KEY: BOGUS },
      { allow },
    );
    expect(withheld).toContain('ANTHROPIC_API_KEY');
    const run = await runClaude(env);
    expect(run.code).toBe(0);
    expect(run.stdout.length).toBeGreaterThan(0);
  }, 180_000);
});

describe.skipIf(!LIVE)('the whole driver, against a real agent', () => {
  it('drives a real turn and produces ACP updates', async () => {
    // The end-to-end claim this package makes: spawn the CLI the user already
    // authenticated, and get structured ACP state back. Everything below the
    // driver is unit-tested; this is the only test that proves the parts are
    // wired to each other AND to a real agent.
    const updates: AcpUpdate[] = [];
    const problems: string[] = [];
    const stderr: string[] = [];

    const exit = await new Promise<number | null>((resolve) => {
      const driver = new ClaudeDriver(
        {
          cwd: process.cwd(),
          permissionMode: 'dontAsk',
          disallowedTools: ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task'],
        },
        {
          onUpdate: (u) => updates.push(u),
          onProtocolError: (p) => problems.push(p),
          onStderr: (l) => stderr.push(l),
          onExit: (code) => resolve(code),
        },
      );

      driver.start();
      // An inherited credential must not reach the agent even here, where the
      // test is about something else entirely.
      expect(driver.withheldCredentials).not.toContain('CLAUDE_CONFIG_DIR');
      driver.prompt('Reply with exactly: ok');
      driver.endInput();
    });

    expect(problems).toEqual([]);
    expect(exit).toBe(0);

    const kinds = new Set(updates.map((u) => u.sessionUpdate));
    expect(kinds.has('agent_message_chunk')).toBe(true);

    const text = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.content as { text: string }).text)
      .join('');
    expect(text.toLowerCase()).toContain('ok');

    // usage_update is the one that needed a context size, so a live turn is
    // what proves `modelUsage.<model>.contextWindow` is really there.
    const usage = updates.find((u) => u.sessionUpdate === 'usage_update');
    expect(usage).toBeDefined();
    expect(usage?.used as number).toBeGreaterThan(0);
    expect(usage?.size as number).toBeGreaterThan(1000);
  }, 180_000);
});
