import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restrictToCurrentUser } from '../src/private-directory.js';
import { prepareProcessTree, windowsApprovalAdapter, createWindowsPrivateDirectory } from '../src/process-tree.js';
import { measureAcl, timingEnabled } from './fixtures/acl-native-timing.mjs';

/*
 * A private directory is readable by the current user and NOBODY else, whatever grants it started with. Removing
 * inherited entries is not enough: an explicit grant (here Everyone, which a parent or a creator can leave behind)
 * survived `/inheritance:r /grant:r` in 0.25.1 (G-118). Read back through .NET by SID, not by icacls' localised names.
 */

const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const EVERYONE = 'S-1-1-0';

function currentSid(): string {
  const out = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });

  return out.match(/\bS-\d+(?:-\d+)+\b/)![0];
}

/** Every access rule on the directory as `SID|inherited|type`, read by .NET with no PowerShell modules. */
function rules(directory: string, file = false): string[] {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PSMODULEPATH') delete env[name];
  const script = `$a=[System.IO.${file ? 'File' : 'Directory'}]::GetAccessControl('${directory.replace(/'/g, "''")}');`
    + `'protected='+$a.AreAccessRulesProtected;`
    + `$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|%{$_.IdentityReference.Value+'|'+$_.IsInherited+'|'+$_.AccessControlType}`;
  const out = execFileSync(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env });

  return out.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
}

describe.skipIf(process.platform !== 'win32')('restrictToCurrentUser', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'prism-acp-private-')); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  for (let sample = 1; sample <= (timingEnabled ? 30 : 1); sample++) {
  it('leaves the current user as the only grant, even when an explicit Everyone grant was there first' + (timingEnabled ? ` [sample ${sample}]` : ''), () => measureAcl(sample, () => {
    execFileSync(join(system32, 'icacls.exe'), [directory, '/grant', `*${EVERYONE}:(OI)(CI)RX`], { stdio: 'pipe', windowsHide: true });
    expect(rules(directory).some((rule) => rule.startsWith(`${EVERYONE}|False|`))).toBe(true); // the planted grant is real

    restrictToCurrentUser(directory);

    expect(rules(directory)).toEqual(['protected=True', `${currentSid()}|False|Allow`]);
  }), timingEnabled ? 120000 : undefined); // Diagnostic-only budget; ordinary test still uses the unchanged 5000ms default.
  }

  it('does the same for a directory with only its inherited grants', () => {
    restrictToCurrentUser(directory);

    expect(rules(directory)).toEqual(['protected=True', `${currentSid()}|False|Allow`]);
  });

  it('creates a private child using the quiet native path and independently reads back only this user', async () => {
    await prepareProcessTree({ directory: join(directory, 'owned-supervisor') });
    const child = join(directory, 'owned-created');
    createWindowsPrivateDirectory(child);
    expect(rules(child)).toEqual(['protected=True', `${currentSid()}|False|Allow`]);
  });

  it('refuses existing directories and files without changing their contents or grants', async () => {
    await prepareProcessTree({ directory: join(directory, 'owned-supervisor') });
    const existing = join(directory, 'owned-existing'); mkdirSync(existing);
    const marker = join(existing, 'owned-marker'); writeFileSync(marker, 'owned');
    const before = rules(existing);
    expect(() => createWindowsPrivateDirectory(existing)).toThrow('failed to protect');
    expect(rules(existing)).toEqual(before);
    expect(readFileSync(marker, 'utf8')).toBe('owned');
    expect(() => createWindowsPrivateDirectory(marker)).toThrow('failed to protect');
    expect(readFileSync(marker, 'utf8')).toBe('owned');
  });

  it('refuses a planted junction without modifying its target', async () => {
    await prepareProcessTree({ directory: join(directory, 'owned-supervisor') });
    const target = join(directory, 'owned-target'); mkdirSync(target);
    const marker = join(target, 'marker'); writeFileSync(marker, 'owned');
    const junction = join(directory, 'owned-link'); symlinkSync(target, junction, 'junction');
    try {
      expect(() => createWindowsPrivateDirectory(junction)).toThrow('failed to protect');
      expect(readFileSync(marker, 'utf8')).toBe('owned');
    } finally { unlinkSync(junction); }
  });

  it('refuses relative paths and missing parents without creating partial directories', async () => {
    await prepareProcessTree({ directory: join(directory, 'owned-supervisor') });
    expect(() => createWindowsPrivateDirectory('owned-relative')).toThrow('must be absolute');
    const absent = join(directory, 'absent');
    expect(() => createWindowsPrivateDirectory(join(absent, 'child'))).toThrow('failed to protect');
    expect(existsSync(absent)).toBe(false);
  });

  it('supervisor generations and their atomic pointer inherit only the private cache owner', async () => {
    restrictToCurrentUser(directory);
    await prepareProcessTree({ directory });
    const expected = ['protected=False', `${currentSid()}|True|Allow`];
    expect(rules(windowsApprovalAdapter(), true)).toEqual(expected);
    expect(rules(join(directory, 'prism-acp-supervisor.current.sha256'), true)).toEqual(expected);
    expect(rules(directory)).toEqual(['protected=True', `${currentSid()}|False|Allow`]);
  });
});
