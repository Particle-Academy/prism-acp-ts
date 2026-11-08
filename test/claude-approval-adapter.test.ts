import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDriver } from '../src/claude/driver.js';
import { prepareProcessTree, supervisorPath } from '../src/process-tree.js';

describe.runIf(process.platform === 'win32')('native approval adapter startup refusal', () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'prism-approval-shipped-')); });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  for (const altered of [false, true]) it((altered ? 'altered' : 'missing') + ' shipped adapter refuses before any CLI/configuration', async () => {
    const executable = join(root, altered ? 'altered.exe' : 'missing.exe');
    if (altered) {
      copyFileSync(supervisorPath(), executable);
      const bytes = readFileSync(executable); bytes[bytes.length - 1] ^= 1; writeFileSync(executable, bytes);
    }
    const marker = join(root, altered ? 'altered-ran' : 'missing-ran'), script = join(root, 'provider-' + altered + '.mjs');
    writeFileSync(script, "import{writeFileSync}from'node:fs';writeFileSync(" + JSON.stringify(marker) + ",'must not run');");
    const before = readdirSync(root);
    try {
      await expect(prepareProcessTree({ executable })).rejects.toThrow(altered ? /does not match/ : /unavailable/);
      const driver = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [script], permissionPrompts: { tools: ['Bash'] } });
      expect(() => driver.start()).toThrow(/cannot prepare Claude approval adapter/);
      expect(driver.processTree).toBe(null); expect(existsSync(marker)).toBe(false); expect(readdirSync(root)).toEqual(before);
    } finally { await prepareProcessTree({ executable: supervisorPath() }); }
  });
});
