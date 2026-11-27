import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeAccounts,
  claudeUsageRateLimitReading,
  clearClaudeRateLimitCache,
  OUTRANKING_CREDENTIALS,
  readClaudeRateLimits,
} from '../src/index.js';

/**
 * G-394 (tynn #1084): one Claude account's limit windows, read WITHOUT a turn and without touching its credential.
 *
 * The source is the CLI's own SDK control request `get_usage` with `skip_behaviors: true`, measured on claude-code
 * 2.1.332 (2026-11-27): an unauthenticated directory answers `rate_limits_available: false, rate_limits: null`; a
 * signed-in Max account answers windows keyed by name plus `model_scoped[]` per-model caps. The stand-in below answers
 * with those SHAPES (values invented) and records, per run, its argv, the NAMES of its environment, CLAUDE_CONFIG_DIR
 * and every stdin line, so a test can prove that no user message (no turn) and no credential reached it.
 */

// Every path any fs function is handed while `watch.active`: the proof this package opens nothing under the account
// directory and no credential file. Wraps EVERY export (and fs.promises), so a new call site cannot slip past a list.
const watch = vi.hoisted(() => ({ active: false, paths: [] as string[] }));
function spyModule<T extends object>(actual: T, record: (args: unknown[]) => void): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') {
      out[name] = new Proxy(value, {
        apply: (target, self, args) => { record(args); return Reflect.apply(target, self, args); },
        construct: (target, args, nt) => { record(args); return Reflect.construct(target, args, nt); },
      });
    } else if (name === 'promises' && typeof value === 'object' && value !== null) {
      out[name] = spyModule(value as object, record);
    } else {
      out[name] = value;
    }
  }
  return out as T;
}
const recordPaths = vi.hoisted(() => (args: unknown[]) => {
  if (!watch.active) return;
  for (const arg of args.slice(0, 2)) {
    if (typeof arg === 'string') watch.paths.push(arg);
    else if (arg instanceof URL) watch.paths.push(arg.pathname);
    else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(arg)) watch.paths.push(arg.toString());
  }
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const wrapped = spyModule(actual, recordPaths);
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const wrapped = spyModule(actual, recordPaths);
  return { ...wrapped, default: wrapped };
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
const tmp = (prefix = 'prism-g394-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
beforeEach(() => { watch.active = false; watch.paths = []; clearClaudeRateLimitCache(); });

const SECRET = 'sk-ant-must-never-reach-the-child';
const RESET_7D = '2026-12-01T08:00:00.000Z';
const RESET_FABLE = '2026-12-02T09:30:00.000Z';

/** The measured signed-in shape (values invented), including passthrough keys this package must NOT carry. */
const SIGNED_IN = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 500, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 34, resets_at: RESET_7D, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    tangelo: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
    limits: [{ kind: 'weekly_all', group: 'weekly', percent: 34, severity: 'normal', resets_at: RESET_7D, scope: null, is_active: true }],
    spend: { used: { amount_minor: 1234, currency: 'USD', exponent: 2 }, percent: 0, disclaimer: 'x' },
    model_scoped: [{ display_name: 'Fable', utilization: 12.5, resets_at: RESET_FABLE }],
  },
  behaviors: null,
};
const UNAUTHENTICATED = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 603, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: null,
  rate_limits_available: false,
  rate_limits: null,
  behaviors: null,
};

type Behaviour =
  | { mode: 'answer'; response: unknown; noise?: boolean; delayMs?: number }
  | { mode: 'error'; error: string }
  | { mode: 'hang' }
  | { mode: 'exit' }
  | { mode: 'flood' };

/** A Claude CLI stand-in answering `get_usage` per config directory ('default' = CLAUDE_CONFIG_DIR unset). */
function standIn(table: Record<string, Behaviour>) {
  const dir = tmp('prism-g394-cli-');
  const script = join(dir, 'claude.mjs');
  const log = join(dir, 'runs.jsonl');
  const file = join(dir, 'table.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(table).map(([k, v]) => [k === 'default' ? k : resolve(k).toLowerCase(), v]))));
  writeFileSync(script, `
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const names = Object.keys(process.env);
const configDir = process.env.CLAUDE_CONFIG_DIR;
const run = Math.random().toString(36).slice(2);
const note = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ run, ...entry }) + '\\n');
note({ args, names, configDir: configDir ?? null });
const table = JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8'));
const behaviour = table[configDir === undefined ? 'default' : resolve(configDir).toLowerCase()] ?? { mode: 'answer', response: ${JSON.stringify(UNAUTHENTICATED)} };
if (behaviour.mode === 'exit') process.exit(3);
if (behaviour.mode === 'flood') { const big = 'x'.repeat(65536); for (let i = 0; i < 40; i++) process.stdout.write(JSON.stringify({ type: 'system', subtype: 'noise', big }) + '\\n'); }
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    note({ stdin: line });
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type !== 'control_request' || frame.request?.subtype !== 'get_usage') continue;
    if (behaviour.mode === 'hang') continue;
    const reply = () => {
      if (behaviour.noise) {
        process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'someone-else', response: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 99, resets_at: null } } } } }) + '\\n');
        process.stdout.write('not json\\n');
        process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\\n');
      }
      const response = behaviour.mode === 'error'
        ? { subtype: 'error', request_id: frame.request_id, error: behaviour.error }
        : { subtype: 'success', request_id: frame.request_id, response: behaviour.response };
      process.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\\n');
    };
    if (behaviour.delayMs) setTimeout(reply, behaviour.delayMs); else reply();
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  type Entry = { run: string; args?: string[]; names?: string[]; configDir?: string | null; stdin?: string };
  const entries = (): Entry[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry) : []);
  const runs = () => {
    const all = entries();
    return all.filter((e) => e.args !== undefined).map((start) => ({
      args: start.args!, names: start.names!, configDir: start.configDir ?? null,
      stdin: all.filter((e) => e.run === start.run && e.stdin !== undefined).map((e) => e.stdin!),
    }));
  };
  return { binary: process.execPath, binaryArgs: [script], runs };
}

describe('readRateLimits(): the account\'s windows, from the CLI\'s get_usage control request', () => {
  it('reports every window the CLI names, plus per-model caps with their scope, and nothing else', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'answer', response: SIGNED_IN } });
    const before = Date.now();
    const reading = await claudeAccounts.readRateLimits(account, { ...cli, cwd: tmp() });
    expect(reading).toMatchObject({ state: 'reported', limited: false, absent: 'not_stated' });
    expect(reading.asOfMs).toBeGreaterThanOrEqual(before);
    expect(reading.windows).toEqual([
      { id: 'claude:seven_day', label: 'seven day', lengthSeconds: null, usedPercent: 34, resetsAtMs: Date.parse(RESET_7D) },
      { id: 'claude:model:fable', label: 'Fable weekly', lengthSeconds: null, usedPercent: 12.5, resetsAtMs: Date.parse(RESET_FABLE), scope: { model: 'Fable' } },
    ]);
    // No plan, spend, credits, session cost or passthrough key reaches the host.
    const json = JSON.stringify(reading);
    for (const leaked of ['max', 'spend', 'amount_minor', 'weekly_all', 'total_cost_usd', 'extra_usage', 'tangelo']) expect(json).not.toContain(leaked);
  });

  it('any number of windows: a window the server adds later is carried by its own name', async () => {
    const account = tmp();
    const response = { ...SIGNED_IN, rate_limits: { ...SIGNED_IN.rate_limits,
      five_hour: { utilization: 7, resets_at: RESET_7D },
      seven_day_opus: { utilization: 1, resets_at: null },
      some_new_window: { utilization: 50, resets_at: RESET_7D },
      model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: RESET_FABLE }, { display_name: 'Opus 5', utilization: null, resets_at: null }] } };
    const cli = standIn({ [account]: { mode: 'answer', response } });
    const reading = await readClaudeRateLimits(account, { ...cli, cwd: tmp() });
    expect(reading.windows.map((w) => w.id)).toEqual(['claude:five_hour', 'claude:seven_day', 'claude:seven_day_opus', 'claude:some_new_window', 'claude:model:fable', 'claude:model:opus_5']);
    // A name like seven_day_opus is never turned into a model scope; only model_scoped rows carry one.
    expect(reading.windows.find((w) => w.id === 'claude:seven_day_opus')).not.toHaveProperty('scope');
    expect(reading.windows.find((w) => w.id === 'claude:model:opus_5')).toMatchObject({ usedPercent: null, resetsAtMs: null, scope: { model: 'Opus 5' } });
  });

  it('a used-up window is limited, and overage is not capped', async () => {
    const account = tmp();
    const response = { ...SIGNED_IN, rate_limits: { seven_day: { utilization: 104.5, resets_at: RESET_7D }, model_scoped: [] } };
    const cli = standIn({ [account]: { mode: 'answer', response } });
    const reading = await readClaudeRateLimits(account, { ...cli, cwd: tmp() });
    expect(reading).toMatchObject({ state: 'reported', limited: true });
    expect(reading.windows).toEqual([{ id: 'claude:seven_day', label: 'seven day', lengthSeconds: null, usedPercent: 104.5, resetsAtMs: Date.parse(RESET_7D), limited: true }]);
  });

  it('an unauthenticated (or API-key) directory is unsupported with a reason code, never a throw', async () => {
    const account = tmp();
    const cli = standIn({});
    const reading = await readClaudeRateLimits(account, { ...cli, cwd: tmp() });
    expect(reading).toMatchObject({ state: 'unsupported', reasonCode: 'no_plan_limits', limited: false, windows: [] });
  });

  it('runs no turn: the only line written is one get_usage control request with skip_behaviors', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'answer', response: SIGNED_IN } });
    await readClaudeRateLimits(account, { ...cli, cwd: tmp() });
    const [run] = cli.runs();
    expect(run.stdin).toHaveLength(1);
    const frame = JSON.parse(run.stdin[0]!) as Record<string, unknown>;
    expect(frame).toMatchObject({ type: 'control_request', request: { subtype: 'get_usage', skip_behaviors: true } });
    expect(Object.keys(frame.request as object).sort()).toEqual(['skip_behaviors', 'subtype']);
    expect(run.args).toEqual(expect.arrayContaining(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--safe-mode', '--strict-mcp-config', '--no-session-persistence']));
    expect(run.args[run.args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(JSON.parse(run.args[run.args.indexOf('--settings') + 1]!)).toEqual({ disableRemoteControl: true });
  });

  it('never touches a credential: no fs call under the directory, no credential variable in the child', async () => {
    const account = tmp();
    writeFileSync(join(account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
    const cli = standIn({ [account]: { mode: 'answer', response: SIGNED_IN } });
    const parentEnv = { ...process.env, ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET, anthropic_auth_token: SECRET };
    watch.active = true;
    const reading = await readClaudeRateLimits(account, { ...cli, cwd: tmp(), parentEnv, allowEnv: ['ANTHROPIC_API_KEY'] });
    watch.active = false;
    expect(reading.state).toBe('reported');
    const fold = (p: string) => resolve(p).toLowerCase();
    expect(watch.paths.filter((p) => fold(p).startsWith(fold(account)))).toEqual([]);
    expect(watch.paths.filter((p) => /credentials|\.claude\.json|keychain/i.test(p))).toEqual([]);
    const [run] = cli.runs();
    expect(run.configDir).toBe(resolve(account));
    const seen = run.names.map((n) => n.toUpperCase());
    for (const name of OUTRANKING_CREDENTIALS) expect(seen).not.toContain(name);
    expect(JSON.stringify(reading)).not.toContain(SECRET);
  });

  it('null asks the CLI default account: CLAUDE_CONFIG_DIR is removed, even an inherited one', async () => {
    const elsewhere = tmp();
    const cli = standIn({ default: { mode: 'answer', response: SIGNED_IN } });
    const reading = await readClaudeRateLimits(null, { ...cli, cwd: tmp(), parentEnv: { ...process.env, CLAUDE_CONFIG_DIR: elsewhere }, allowEnv: ['CLAUDE_CONFIG_DIR'] });
    expect(reading.state).toBe('reported');
    expect(cli.runs()[0]!.configDir).toBeNull();
  });
});

describe('readRateLimits(): unknown, never a throw', () => {
  it('a CLI that refuses the request (too old for get_usage)', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'error', error: 'get_usage is not supported in this context' } });
    const reading = await readClaudeRateLimits(account, { ...cli, cwd: tmp() });
    expect(reading).toMatchObject({ state: 'unreadable', reasonCode: 'refused', windows: [] });
    expect(reading.reason).not.toContain('not supported in this context');
  });

  it('a CLI that never answers is bounded by the timeout, and the child is stopped', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'hang' } });
    const started = Date.now();
    const reading = await readClaudeRateLimits(account, { ...cli, cwd: tmp(), timeoutMs: 1_000 });
    expect(reading).toMatchObject({ state: 'unreadable', reasonCode: 'timeout' });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('a CLI that exits before answering', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'exit' } });
    expect(await readClaudeRateLimits(account, { ...cli, cwd: tmp() })).toMatchObject({ state: 'unreadable', reasonCode: 'cli_exited' });
  });

  it('a CLI that is not there', async () => {
    const reading = await readClaudeRateLimits(tmp(), { binary: join(tmp(), 'no-such-claude'), cwd: tmp() });
    expect(reading).toMatchObject({ state: 'unreadable' });
    expect(['cli_unavailable', 'cli_exited']).toContain(reading.reasonCode);
  });

  it('a CLI that floods stdout before answering is cut off at the bound', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'flood' } });
    expect(await readClaudeRateLimits(account, { ...cli, cwd: tmp() })).toMatchObject({ state: 'unreadable', reasonCode: 'too_large' });
  });

  it('bad options are unknown, and nothing is run', async () => {
    const cli = standIn({});
    for (const [dir, extra] of [
      ['relative/dir', {}],
      [join(tmp(), 'a\u0000b'), {}],
      [tmp(), { timeoutMs: 0 }],
      [tmp(), { timeoutMs: Number.NaN }],
      [tmp(), { maxAgeMs: -1 }],
      [tmp(), { binaryArgs: [...cli.binaryArgs, '--remote-control'] }],
      [tmp(), { binaryArgs: [...cli.binaryArgs, '--settings', '{}'] }],
    ] as const) {
      const reading = await readClaudeRateLimits(dir as string, { ...cli, cwd: tmp(), ...extra });
      expect(reading).toMatchObject({ state: 'unreadable', reasonCode: 'invalid_options' });
    }
    expect(cli.runs()).toEqual([]);
  });

  it('available but no rate limits: the usage endpoint did not answer', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'answer', response: { ...SIGNED_IN, rate_limits: null } } });
    expect(await readClaudeRateLimits(account, { ...cli, cwd: tmp() })).toMatchObject({ state: 'unreadable', reasonCode: 'unavailable' });
  });

  it('ignores other request ids, non-JSON and non-control frames before its own answer', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'answer', response: SIGNED_IN, noise: true } });
    const reading = await readClaudeRateLimits(account, { ...cli, cwd: tmp() });
    expect(reading.windows.find((w) => w.id === 'claude:seven_day')?.usedPercent).toBe(34);
  });
});

describe('readRateLimits(): cached, so the CLI is not hammered', () => {
  it('a reported reading is reused within maxAgeMs, and concurrent callers share one CLI', async () => {
    const account = tmp();
    const cli = standIn({ [account]: { mode: 'answer', response: SIGNED_IN, delayMs: 200 } });
    const options = { ...cli, cwd: tmp() };
    const [a, b] = await Promise.all([readClaudeRateLimits(account, options), readClaudeRateLimits(account, options)]);
    const c = await readClaudeRateLimits(account, options);
    expect(cli.runs()).toHaveLength(1);
    expect(b).toEqual(a);
    expect(c.asOfMs).toBe(a.asOfMs);
  });

  it('maxAgeMs 0 always asks; another directory is another entry', async () => {
    const account = tmp();
    const other = tmp();
    const cli = standIn({ [account]: { mode: 'answer', response: SIGNED_IN }, [other]: { mode: 'answer', response: SIGNED_IN } });
    await readClaudeRateLimits(account, { ...cli, cwd: tmp(), maxAgeMs: 0 });
    await readClaudeRateLimits(account, { ...cli, cwd: tmp(), maxAgeMs: 0 });
    await readClaudeRateLimits(other, { ...cli, cwd: tmp() });
    expect(cli.runs()).toHaveLength(3);
  });
});

describe('claudeUsageRateLimitReading(): the get_usage parser, refusing rather than guessing', () => {
  const now = 1_000;
  const read = (rateLimits: unknown, extra: Record<string, unknown> = {}) =>
    claudeUsageRateLimitReading({ rate_limits_available: true, rate_limits: rateLimits, ...extra }, now);

  it('refuses a declared window with the wrong shape, a bad unit or a bad date, without quoting the value', () => {
    for (const bad of [
      { seven_day: { used: 34, resets_at: RESET_7D } },
      { seven_day: { utilization: '34', resets_at: RESET_7D } },
      { seven_day: { utilization: -1, resets_at: RESET_7D } },
      { seven_day: { utilization: Number.POSITIVE_INFINITY, resets_at: RESET_7D } },
      { seven_day: { utilization: 3, resets_at: 'not-a-date-sk-ant-xyz' } },
      { seven_day: { utilization: 3, resets_at: 1764576000 } },
      { five_hour: 'full' },
      { model_scoped: 'Fable' },
      { model_scoped: [{ display_name: 7, utilization: 1, resets_at: null }] },
    ]) {
      const reading = read(bad);
      expect(reading).toMatchObject({ state: 'unreadable', reasonCode: 'malformed', windows: [] });
      expect(reading.reason).not.toContain('sk-ant');
    }
  });

  it('refuses an unsafe window name and more windows than the bound, never truncating', () => {
    expect(read({ 'evil name<script>': { utilization: 1, resets_at: null } })).toMatchObject({ state: 'unreadable', reasonCode: 'malformed' });
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`w${i}`, { utilization: 1, resets_at: null }]));
    expect(read(many)).toMatchObject({ state: 'unreadable', reasonCode: 'malformed' });
  });

  it('cleans server text in a model label and makes a safe id; duplicate ids are numbered', () => {
    const reading = read({ model_scoped: [
      { display_name: 'Fa\u001b[31mble\u0007', utilization: 1, resets_at: null },
      { display_name: 'Fable', utilization: 2, resets_at: null },
      { display_name: '​', utilization: 3, resets_at: null },
    ] });
    expect(reading.state).toBe('reported');
    expect(reading.windows.map((w) => w.id)).toEqual(['claude:model:fable', 'claude:model:fable:2', 'claude:model:model']);
    expect(reading.windows[0]).toMatchObject({ label: 'Fable weekly', scope: { model: 'Fable' } });
    for (const w of reading.windows) expect(w.id).toMatch(/^claude:[a-z0-9_.:-]+$/);
  });

  it('ignores keys that are not windows (spend, credits, lists) and null windows', () => {
    const reading = read({ five_hour: null, spend: { percent: 9 }, extra_usage: { utilization: 5 }, limits: [], pace: 'fast', seven_day: { utilization: 0, resets_at: null } });
    expect(reading.windows.map((w) => w.id)).toEqual(['claude:seven_day']);
  });

  it('is unsupported when the CLI says plan limits do not apply, and unreadable for a non-object', () => {
    expect(claudeUsageRateLimitReading({ rate_limits_available: false, rate_limits: null }, now)).toMatchObject({ state: 'unsupported', reasonCode: 'no_plan_limits' });
    expect(claudeUsageRateLimitReading('nope', now)).toMatchObject({ state: 'unreadable', reasonCode: 'malformed' });
    expect(claudeUsageRateLimitReading({ rate_limits_available: 'yes' }, now)).toMatchObject({ state: 'unreadable', reasonCode: 'malformed' });
  });
});
