#!/usr/bin/env node
/**
 * LAB-PROVE Claude account selection (claude/accounts.ts, PR #65) against the REAL Claude Code CLI (G-317).
 *
 * Six checks, each recorded pass/fail:
 *   1. describe(null): the default account. Only signedIn, method, directoryMatched, and whether email/plan are
 *      PRESENT (booleans). The email itself is never recorded.
 *   2. describe(<fresh temp dir>): expect signedIn false, method none.
 *   3. check({ configDir: <fresh temp dir>, method: 'subscription' }): expect state signedOut.
 *   4. A selection naming a different directory from the one the default account's status came from: expect mismatch
 *      with directory among the differences (the status is for another directory), and compare(null selection,
 *      describe(null)) stays ready. check() always describes the selection's own directory, so the
 *      pairing is built with compare(selection, describe(null)) -- the case of a host holding a status for one account
 *      and a selection for another.
 *   5. A stray ANTHROPIC_API_KEY does not take over: with a FAKE key in this process's environment, describe(null) must
 *      not read as method apiKey, and ONE short ClaudeDriver turn with configDir: null must not fail on the fake key.
 *      Only the outcome kind is recorded.
 *   6. loginCommand(<temp dir>): a command and an env setting CLAUDE_CONFIG_DIR. Shape only; never executed.
 *
 * Nothing here reads a file under any Claude configuration directory, and nothing logs in or out. Temp directories
 * live under --scratch and are deleted at the end. The live turn (check 5b) runs only when every other check passed,
 * and only with --turn: it is one paid subscription turn.
 *
 *   npm run build && node scripts/probe-claude-accounts.mjs --scratch <dir> [--turn] [--binary <path>]
 *
 * Prints one JSON report on stdout. Exit 0 = every check that ran passed; 1 = a check failed; 2 = it could not run.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClaudeDriver, claudeAccounts } from '../dist/index.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const binary = option('--binary', 'claude');
const scratchArg = option('--scratch', undefined);
const turn = argv.includes('--turn');
if (scratchArg === undefined) {
  process.stdout.write(`${JSON.stringify({ ran: false, reason: '--scratch <dir> is required' })}\n`);
  process.exit(2);
}
const FAKE_KEY = 'sk-ant-fake-probe';

const root = resolve(scratchArg, `run-${randomUUID()}`);
const fresh = join(root, 'fresh');
const other = join(root, 'other');
mkdirSync(root, { recursive: true });

const cliVersion = (() => {
  try { return execFileSync(binary, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 15_000 }).trim(); } catch { return null; }
})();
let commit = null;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }

/** What may be recorded about a status: never the email, organisation, or anything the CLI may add later. */
const safe = (s) => ({
  signedIn: s.signedIn,
  method: s.method,
  cliAuthMethod: s.cliAuthMethod,
  billing: s.billing,
  directoryMatched: s.configDirectoryMatches,
  emailPresent: s.email !== undefined,
  planPresent: s.subscriptionType !== undefined,
  apiKeySource: s.apiKeySource ?? null,
  anthropicApiKeyWithheld: s.withheld.includes('ANTHROPIC_API_KEY'),
});

const checks = {};
const record = (name, pass, observed, expected) => { checks[name] = { pass, expected, observed }; };
const guarded = async (name, expected, fn) => {
  try { await fn(); } catch (cause) { record(name, false, { error: cause?.name ?? 'Error', message: String(cause?.message ?? cause).slice(0, 200) }, expected); }
};

let defaultStatus = null;
const hadKeyBefore = Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY');
const keyBefore = process.env.ANTHROPIC_API_KEY;
try {
  // 1. The default account.
  await guarded('1-describe-default', 'signedIn true, directoryMatched true', async () => {
    defaultStatus = await claudeAccounts.describe(null, { binary });
    const o = safe(defaultStatus);
    record('1-describe-default', o.signedIn && o.directoryMatched && o.method !== 'none', o, 'signedIn true, directoryMatched true');
  });

  // 2. A fresh directory.
  await guarded('2-describe-fresh', 'signedIn false, method none', async () => {
    const o = safe(await claudeAccounts.describe(fresh, { binary }));
    record('2-describe-fresh', o.signedIn === false && o.method === 'none' && o.directoryMatched, o, 'signedIn false, method none, directoryMatched true');
  });

  // 3. A subscription selection on the fresh directory.
  await guarded('3-check-fresh-signedOut', 'state signedOut', async () => {
    const result = await claudeAccounts.check({ configDir: fresh, method: 'subscription' }, { binary });
    record('3-check-fresh-signedOut', result.state === 'signedOut', { state: result.state }, 'state signedOut');
  });

  // 4. A selection naming a different directory from the default account's.
  await guarded('4-mismatch-directory', 'state mismatch, differences include directory', async () => {
    if (defaultStatus === null) throw new Error('no default status (check 1 failed)');
    const live = await claudeAccounts.check({ configDir: null, method: defaultStatus.method === 'subscription' ? 'subscription' : 'console' }, { binary });
    const method = defaultStatus.method === 'subscription' ? 'subscription' : 'console';
    const result = claudeAccounts.compare({ configDir: other, method }, defaultStatus);
    // The other side of the guard: the same status compared with the default selection must stay ready.
    const same = claudeAccounts.compare({ configDir: null, method }, defaultStatus);
    record('4-mismatch-directory',
      result.state === 'mismatch' && result.differences.includes('directory') && same.state === 'ready' && live.state === 'ready',
      {
        liveDefaultCheckState: live.state,
        compareState: result.state,
        differences: result.state === 'mismatch' ? result.differences : [],
        compareDefaultWithDefaultState: same.state,
      },
      'state mismatch, differences include directory; the default selection with the same status stays ready');
  });

  // 6. The login command for a directory: shape only, never executed.
  await guarded('6-login-command-shape', 'command + args auth login --claudeai, env.CLAUDE_CONFIG_DIR = dir', async () => {
    const cmd = claudeAccounts.loginCommand(fresh);
    const o = {
      command: cmd.command,
      args: [...cmd.args],
      envSetsConfigDir: cmd.env.CLAUDE_CONFIG_DIR === resolve(fresh),
      setKeys: Object.keys(cmd.set),
      unsetIncludesAnthropicApiKey: cmd.unset.includes('ANTHROPIC_API_KEY'),
      envCarriesAnthropicApiKey: Object.prototype.hasOwnProperty.call(cmd.env, 'ANTHROPIC_API_KEY'),
      displayPowershellSetsConfigDir: cmd.display.powershell.includes('$env:CLAUDE_CONFIG_DIR'),
      displayPosixSetsConfigDir: cmd.display.posix.includes('CLAUDE_CONFIG_DIR='),
      executed: false,
    };
    record('6-login-command-shape',
      o.command === binary && o.args[0] === 'auth' && o.args[1] === 'login' && o.args.includes('--claudeai') && o.envSetsConfigDir
        && !o.envCarriesAnthropicApiKey && o.displayPowershellSetsConfigDir && o.displayPosixSetsConfigDir,
      o, 'command + args auth login --claudeai, env.CLAUDE_CONFIG_DIR = dir, no ANTHROPIC_API_KEY in env');
  });

  // 5. A stray key in the parent environment.
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  await guarded('5a-stray-key-describe', 'method not apiKey; ANTHROPIC_API_KEY withheld', async () => {
    const o = safe(await claudeAccounts.describe(null, { binary }));
    record('5a-stray-key-describe', o.method !== 'apiKey' && o.anthropicApiKeyWithheld && o.method === (defaultStatus?.method ?? o.method),
      o, 'method not apiKey, same method as check 1, ANTHROPIC_API_KEY withheld');
  });

  const others = Object.entries(checks).filter(([name]) => name !== '5b-stray-key-turn');
  const allPassed = others.every(([, c]) => c.pass);
  if (!turn) {
    checks['5b-stray-key-turn'] = { pass: null, skipped: 'run without --turn' };
  } else if (!allPassed) {
    checks['5b-stray-key-turn'] = { pass: null, skipped: 'an earlier check failed; the paid turn was not spent' };
  } else {
    await guarded('5b-stray-key-turn', 'turn ends end_turn, not an auth failure', async () => {
      const outcome = await new Promise((done, fail) => {
        let exited = false;
        let invalidKeyOnStderr = false;
        const driver = new ClaudeDriver({ cwd: process.cwd(), binary, configDir: null }, {
          onStderr: (line) => { if (/invalid.*(api key|x-api-key)|ANTHROPIC_API_KEY/i.test(line)) invalidKeyOnStderr = true; },
          onTurnEnd: (o) => {
            clearTimeout(timer);
            done({
              stopReason: o.stopReason,
              isError: o.isError,
              failureKind: o.failure?.kind ?? null,
              withheldAnthropicApiKey: driver.withheldCredentials.includes('ANTHROPIC_API_KEY'),
              invalidKeyOnStderr,
            });
            driver.stop({ graceMs: 3_000 }).catch(() => driver.kill());
          },
          onExit: () => { exited = true; },
        });
        const timer = setTimeout(() => { driver.kill(); fail(new Error(exited ? 'CLI exited before the turn ended' : 'turn did not end within 180 s')); }, 180_000);
        driver.start();
        driver.prompt('Reply with the word ok.');
      });
      const kind = outcome.stopReason === 'end_turn' && !outcome.isError ? 'end_turn' : (outcome.failureKind ?? 'error');
      record('5b-stray-key-turn',
        kind === 'end_turn' && outcome.withheldAnthropicApiKey && !outcome.invalidKeyOnStderr,
        { outcomeKind: kind, withheldAnthropicApiKey: outcome.withheldAnthropicApiKey, invalidKeyOnStderr: outcome.invalidKeyOnStderr },
        'outcomeKind end_turn, ANTHROPIC_API_KEY withheld, no invalid-key message');
    });
  }
} finally {
  if (hadKeyBefore) process.env.ANTHROPIC_API_KEY = keyBefore; else delete process.env.ANTHROPIC_API_KEY;
  rmSync(root, { recursive: true, force: true });
}

const ran = Object.values(checks).filter((c) => c.pass !== null);
const pass = ran.every((c) => c.pass);
const report = {
  probe: 'scripts/probe-claude-accounts.mjs',
  item: 'G-317',
  cliVersion,
  package: '@particle-academy/prism-acp',
  commit,
  measuredAt: new Date().toISOString(),
  platform: process.platform,
  liveTurn: turn,
  pass,
  checks,
  tempDirsRemoved: true,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(pass ? 0 : 1);
