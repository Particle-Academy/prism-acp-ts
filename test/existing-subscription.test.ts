import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { childEnv, ClaudeDriver, launchProvider } from '../src/index.js';

const access = vi.hoisted(() => ({ active: false, denied: 0, roots: [] as string[] }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { basename, resolve, sep } = await import('node:path');
  const guard = (value: unknown) => {
    if (!access.active) return;
    const path = resolve(String(value)).toLowerCase();
    if (['auth.json', '.credentials.json', 'credentials.json', 'tokens.json', 'token.json'].includes(basename(path))
      || !access.roots.some(root => path === root || path.startsWith(root + sep))) {
      access.denied++;
      throw new Error('Existing-login initialization must not read credential files or unrelated host files');
    }
  };
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ['readFile', 'readFileSync', 'createReadStream', 'copyFile', 'copyFileSync'] as const) {
    wrapped[name] = (...args: any[]) => { guard(args[0]); if (name.startsWith('copy')) guard(args[1]); return Reflect.apply(actual[name], actual, args); };
  }
  return wrapped;
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const { basename, resolve, sep } = await import('node:path');
  const guard = (value: unknown) => {
    if (!access.active) return;
    const path = resolve(String(value)).toLowerCase();
    if (['auth.json', '.credentials.json', 'credentials.json', 'tokens.json', 'token.json'].includes(basename(path))
      || !access.roots.some(root => path === root || path.startsWith(root + sep))) {
      access.denied++;
      throw new Error('Existing-login initialization must not read credential files or unrelated host files');
    }
  };
  return { ...actual, readFile: (...args: any[]) => { guard(args[0]); return Reflect.apply(actual.readFile, actual, args); },
    copyFile: (...args: any[]) => { guard(args[0]); guard(args[1]); return Reflect.apply(actual.copyFile, actual, args); } };
});

async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Existing-login metadata deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

// Explicit workstation opt-in. CI has no subscription store and must report this skipped, never fake a login.
describe.runIf(process.env.PRISM_ACP_EXISTING_SUBSCRIPTION === '1')('existing subscription host mode, no model turn', () => {
  it('initializes the restricted Claude driver with its existing login and supplied UI MCP without reading stored credentials', async () => {
    const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'prism-acp-existing-login-'));
    const binary = process.env.PRISM_ACP_CLAUDE_BINARY ?? 'claude';
    const marker = join(root, 'mcp-methods.jsonl');
    access.roots = [root, fileURLToPath(new URL('..', import.meta.url)), join(process.env.LOCALAPPDATA ?? tmpdir(), 'prism-acp')].map(path => resolve(path).toLowerCase());
    access.active = true;
    let driver: ClaudeDriver | undefined;
    try {
      const { env } = childEnv(process.env, { allow: ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'] });
      const status = launchProvider(binary, ['--setting-sources', '', 'auth', 'status'], { cwd: root, env });
      let bytes = '', overflow = false;
      status.child.stdout!.on('data', chunk => { if (bytes.length + chunk.length > 32_768) { overflow = true; status.kill(); } else bytes += chunk.toString(); });
      status.child.stderr!.resume();
      try {
        await deadline(status.started, 10_000);
        await deadline(status.closed ?? new Promise<void>(resolve => status.child.once('close', () => resolve())), 15_000);
        if (overflow) throw new Error('Claude auth status exceeded its metadata bound');
        let state: { loggedIn?: unknown; authMethod?: unknown };
        try { state = JSON.parse(bytes); } catch { throw new Error('Claude auth status did not return valid metadata'); }
        // Keep only these booleans in failure diagnostics; never snapshot identity or raw status output.
        expect(state.loggedIn === true).toBe(true);
        expect(state.authMethod === 'claude.ai').toBe(true);
      } finally { expect(await status.stop({ graceMs: 0 })).toMatchObject({ verified: true, empty: true, survivors: 0 }); }

      let protocolErrors = 0;
      driver = new ClaudeDriver({ cwd: root, binary, credentials: { mode: 'subscription' }, nativeTools: 'none',
        mcpServers: [{ name: 'owned_ui', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/existing-login-mcp.mjs', import.meta.url)), marker], env: [] }],
      }, { onProtocolError: () => { protocolErrors++; }, onStderr: () => {} });
      driver.start();
      const models = await deadline(driver.modelState(), 20_000);
      expect(models.availableModels.length).toBeGreaterThan(0);
      const until = Date.now() + 5000;
      while ((!existsSync(marker) || !readFileSync(marker, 'utf8').includes('tools/list')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(marker)).toBe(true);
      const methods = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line).method);
      expect(methods).toContain('initialize'); expect(methods).toContain('tools/list'); expect(methods).not.toContain('tools/call');
      expect(protocolErrors).toBe(0);
      expect(access.denied).toBe(0);
      // No driver.prompt(), user message or turn is sent. Model-emitted native refusal is a separate proof.
    } finally {
      if (driver !== undefined) expect(await driver.stop({ graceMs: 0 })).toMatchObject({ verified: true, empty: true, survivors: 0 });
      access.active = false;
      const suffix = relative(parent, realpathSync(root));
      if (!suffix || suffix.startsWith('..') || isAbsolute(suffix) || !suffix.startsWith('prism-acp-existing-login-')) throw new Error('Owned fixture cleanup escaped its parent');
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
