// The probe behind `session/load`'s early refusal.
//
// Every case here builds its own fake home. None of them reads the developer's
// real `~/.claude/projects`, which is both a correctness point and a privacy
// one: a test that listed real session ids would print them on failure.
//
// The three-state result is the whole design. `indeterminate` exists because
// this reads an UNDOCUMENTED layout, and the failure that matters is not
// "missed a bad id" -- the CLI still catches that a turn later, as it always
// did -- it is refusing a resume that would have worked. So every way of not
// knowing has a test, and all of them proceed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSessionStore, type SessionStoreOptions } from '../src/claude/session-store.js';

const homes: string[] = [];

/**
 * The probe reads `CLAUDE_CONFIG_DIR` from the environment it is handed, and
 * real installations DO set it -- Genie forwards it deliberately. So every case
 * here is given an EMPTY environment unless it is testing that variable:
 * otherwise a developer who has it set would have these cases read their own
 * session store, which is the privacy point in the header above.
 */
const probe = (sessionId: string, options: SessionStoreOptions = {}) =>
  probeSessionStore(sessionId, { env: {}, ...options });

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'prism-acp-store-'));
  homes.push(directory);
  return directory;
}

function populate(root: string, projects: Readonly<Record<string, readonly string[]>>): void {
  for (const [project, files] of Object.entries(projects)) {
    const directory = join(root, 'projects', project);
    mkdirSync(directory, { recursive: true });
    for (const file of files) writeFileSync(join(directory, file), '{}\n');
  }
}

function fakeHome(projects: Readonly<Record<string, readonly string[]>>): string {
  const home = temporary();
  populate(join(home, '.claude'), projects);
  return home;
}

/** A configuration home the way `CLAUDE_CONFIG_DIR` names one: the store IS it. */
function fakeConfigDir(projects: Readonly<Record<string, readonly string[]>>): string {
  const configDir = join(temporary(), 'genie-claude-home');
  mkdirSync(configDir, { recursive: true });
  populate(configDir, projects);
  return configDir;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
});

const PRESENT = 'bfffcfe8-0cab-4af6-9949-e166c5d9f52a';
const ABSENT = '11111111-2222-3333-4444-555555555555';

describe('probeSessionStore', () => {
  it('finds a session by its file, in whichever project holds it', () => {
    // No slug is derived. A session id is a UUID and therefore unique across
    // projects, so the file is enough -- and deriving the slug would mean
    // reimplementing an undocumented rule whose only failure mode is calling a
    // real session absent.
    const home = fakeHome({
      'C---Projects-other': ['99999999-0000-0000-0000-000000000000.jsonl'],
      'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`],
    });

    expect(probe(PRESENT, { home })).toEqual({ existence: 'present', detail: '' });
  });

  it('reports a well-formed id that is in no project as ABSENT', () => {
    const home = fakeHome({ 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });
    const probed = probe(ABSENT, { home });

    expect(probed.existence).toBe('absent');
    expect(probed.detail).toContain(ABSENT);
  });

  it('reports a NON-UUID as absent without touching the disk', () => {
    // Verified against claude 2.1.292: "Provided value ... is not a UUID and
    // does not match any session title." No layout can contain it.
    const probed = probe('sess_123_456', { home: join(tmpdir(), 'does-not-exist-at-all') });

    expect(probed.existence).toBe('absent');
    expect(probed.detail).toContain('not a UUID');
  });

  it('is INDETERMINATE when the store directory does not exist', () => {
    const home = temporary();

    expect(probe(ABSENT, { home }).existence).toBe('indeterminate');
  });

  it('is INDETERMINATE when the store exists but lists no projects', () => {
    // Far more likely to be the wrong store than a genuine record that this
    // conversation never existed.
    const home = fakeHome({});
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

    expect(probe(ABSENT, { home }).existence).toBe('indeterminate');
  });

  it('is INDETERMINATE when the store path is a file rather than a directory', () => {
    const home = temporary();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects'), 'not a directory');

    expect(probe(ABSENT, { home }).existence).toBe('indeterminate');
  });

  it('does not mistake a directory named like the session for the session', () => {
    // The real store carries BOTH `<uuid>.jsonl` and a `<uuid>/` directory
    // beside it. Only the file is the conversation; matching the bare id would
    // report a session present on the strength of a sibling directory.
    const home = fakeHome({ 'C---Projects--packages-prism-agi': [] });
    mkdirSync(join(home, '.claude', 'projects', 'C---Projects--packages-prism-agi', PRESENT), { recursive: true });

    expect(probe(PRESENT, { home }).existence).toBe('absent');
  });

  it('is case-insensitive about the id shape but exact about the file', () => {
    const upper = PRESENT.toUpperCase();
    const home = fakeHome({ 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });

    // The shape check accepts either case, since the CLI's own ids are lower.
    // The lookup is exact, so an upper-case id is reported absent rather than
    // silently matched -- an id that is not byte-identical is not the same id.
    expect(probe(upper, { home }).existence).toBe('absent');
  });

  // ---- CLAUDE_CONFIG_DIR -------------------------------------------------
  //
  // The CLI resolves its configuration home as `CLAUDE_CONFIG_DIR` or, unset,
  // `<home>/.claude`, and keeps `projects` under whichever it picked. 0.4.0
  // read only the second, so on an installation that sets the variable -- Genie
  // forwards it deliberately, because the subscription credential lives there --
  // the probe read a store the CLI does not use and answered ABSENT for a
  // conversation that exists. That refuses a resume that would have worked,
  // which is the one failure this probe is not allowed to have.

  it('resolves the store under CLAUDE_CONFIG_DIR, as the CLI does', () => {
    // The sharp case from the report: the session exists in the store the CLI
    // will actually use, and the default store exists too and is non-empty --
    // so the old code answered `absent` with confidence rather than
    // `indeterminate`.
    const configDir = fakeConfigDir({ 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });
    const home = fakeHome({ 'C---Projects-other': ['99999999-0000-0000-0000-000000000000.jsonl'] });

    expect(probe(PRESENT, { home, env: { CLAUDE_CONFIG_DIR: configDir } })).toEqual({
      existence: 'present',
      detail: '',
    });
  });

  it('does not nest .claude under CLAUDE_CONFIG_DIR', () => {
    // The tempting workaround is to keep the old path and pass
    // `home: dirname(CLAUDE_CONFIG_DIR)`, which only works while the directory
    // happens to be named `.claude`. The variable names the configuration home
    // itself, so `projects` sits directly inside it.
    const configDir = temporary();
    populate(join(configDir, '.claude'), { 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });

    expect(probe(PRESENT, { home: temporary(), env: { CLAUDE_CONFIG_DIR: configDir } }).existence).toBe(
      'indeterminate',
    );
  });

  it('falls back to <home>/.claude when CLAUDE_CONFIG_DIR is empty or blank', () => {
    // The CLI reads it with `||`, not `??`, so an empty value is no value.
    // Resolving the store to `projects` relative to nothing would look in the
    // probe's own working directory.
    const home = fakeHome({ 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });

    for (const blank of ['', '   ']) {
      expect(probe(PRESENT, { home, env: { CLAUDE_CONFIG_DIR: blank } }).existence).toBe('present');
    }
  });

  it('is INDETERMINATE when CLAUDE_CONFIG_DIR is a relative path', () => {
    // The CLI refuses to run at all with a relative configuration home
    // ("the configuration home (CLAUDE_CONFIG_DIR) is not an absolute path"),
    // so there is no store to name. Resolving it against the probe's own cwd
    // would answer `absent` about a directory the CLI never looks in.
    const probed = probe(PRESENT, { home: temporary(), env: { CLAUDE_CONFIG_DIR: 'relative/claude-home' } });

    expect(probed.existence).toBe('indeterminate');
    expect(probed.detail).toContain('absolute');
  });

  it('is INDETERMINATE when CLAUDE_CONFIG_DIR names a store that is not there', () => {
    // Same rule as a missing default store: not knowing is not absence.
    const probed = probe(PRESENT, {
      home: temporary(),
      env: { CLAUDE_CONFIG_DIR: join(temporary(), 'never-created') },
    });

    expect(probed.existence).toBe('indeterminate');
  });

  it('lets an explicit configDir outrank both the environment and home', () => {
    // For a caller that knows where the store is -- or drives a CLI with a
    // `parentEnv` of its own construction.
    const configDir = fakeConfigDir({ 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });
    const home = fakeHome({ 'C---Projects-other': [`${PRESENT}.jsonl`] });

    expect(probe(PRESENT, { home, configDir, env: { CLAUDE_CONFIG_DIR: '/nowhere-at-all' } }).existence).toBe(
      'present',
    );
  });
});
