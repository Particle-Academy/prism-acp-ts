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
import { probeSessionStore } from '../src/claude/session-store.js';

const homes: string[] = [];

function fakeHome(projects: Readonly<Record<string, readonly string[]>>): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-acp-store-'));
  homes.push(home);
  for (const [project, files] of Object.entries(projects)) {
    const directory = join(home, '.claude', 'projects', project);
    mkdirSync(directory, { recursive: true });
    for (const file of files) writeFileSync(join(directory, file), '{}\n');
  }
  return home;
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

    expect(probeSessionStore(PRESENT, { home })).toEqual({ existence: 'present', detail: '' });
  });

  it('reports a well-formed id that is in no project as ABSENT', () => {
    const home = fakeHome({ 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });
    const probe = probeSessionStore(ABSENT, { home });

    expect(probe.existence).toBe('absent');
    expect(probe.detail).toContain(ABSENT);
  });

  it('reports a NON-UUID as absent without touching the disk', () => {
    // Verified against claude 2.1.292: "Provided value ... is not a UUID and
    // does not match any session title." No layout can contain it.
    const probe = probeSessionStore('sess_123_456', { home: join(tmpdir(), 'does-not-exist-at-all') });

    expect(probe.existence).toBe('absent');
    expect(probe.detail).toContain('not a UUID');
  });

  it('is INDETERMINATE when the store directory does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'prism-acp-store-'));
    homes.push(home);

    expect(probeSessionStore(ABSENT, { home }).existence).toBe('indeterminate');
  });

  it('is INDETERMINATE when the store exists but lists no projects', () => {
    // Far more likely to be the wrong store than a genuine record that this
    // conversation never existed.
    const home = fakeHome({});
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

    expect(probeSessionStore(ABSENT, { home }).existence).toBe('indeterminate');
  });

  it('is INDETERMINATE when the store path is a file rather than a directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'prism-acp-store-'));
    homes.push(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects'), 'not a directory');

    expect(probeSessionStore(ABSENT, { home }).existence).toBe('indeterminate');
  });

  it('does not mistake a directory named like the session for the session', () => {
    // The real store carries BOTH `<uuid>.jsonl` and a `<uuid>/` directory
    // beside it. Only the file is the conversation; matching the bare id would
    // report a session present on the strength of a sibling directory.
    const home = fakeHome({ 'C---Projects--packages-prism-agi': [] });
    mkdirSync(join(home, '.claude', 'projects', 'C---Projects--packages-prism-agi', PRESENT), { recursive: true });

    expect(probeSessionStore(PRESENT, { home }).existence).toBe('absent');
  });

  it('is case-insensitive about the id shape but exact about the file', () => {
    const upper = PRESENT.toUpperCase();
    const home = fakeHome({ 'C---Projects--packages-prism-agi': [`${PRESENT}.jsonl`] });

    // The shape check accepts either case, since the CLI's own ids are lower.
    // The lookup is exact, so an upper-case id is reported absent rather than
    // silently matched -- an id that is not byte-identical is not the same id.
    expect(probeSessionStore(upper, { home }).existence).toBe('absent');
  });
});
