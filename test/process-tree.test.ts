import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ProcessTreeError, launchProvider, resolveWindowsCommand, windowsCommandLine, type ProviderProcess } from '../src/process-tree.js';

/**
 * A PROVIDER'S WHOLE PROCESS TREE ENDS WITH IT (tynn, Genie, 2026-10-20). On Windows a Stop killed cmd.exe and left
 * claude.exe or codex, and everything they had started, running; a host crash left the tree running on every OS.
 *
 * Every tree here is real processes, and its deepest member is started DETACHED -- the adversarial case, since a
 * child that only lives in its parent's group would die with almost any approach. Each test reads the pids the tree
 * wrote and checks the OS, not the supervisor's own report.
 */
const isWindows = process.platform === 'win32';
const here = dirname(fileURLToPath(import.meta.url));
const TREE = join(here, 'fixtures', 'process-tree.cjs');
const dirs: string[] = [];
const launched: ProviderProcess[] = [];
afterAll(async () => {
  for (const provider of launched) provider.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'prism-tree-')); dirs.push(d); return d; };

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
async function until<T>(what: string, read: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const pidsIn = (file: string, count: number) => until(`${count} pids`, () => {
  const pids = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
  return pids.length >= count ? pids : undefined;
});

function launchTree(env: Record<string, string> = {}) {
  const dir = tmp();
  const pidFile = join(dir, 'pids');
  const provider = launchProvider(process.execPath, [TREE, pidFile], { cwd: dir, env: { ...process.env, ...env } });
  launched.push(provider);
  let stdout = '';
  provider.child.stdout?.on('data', (d) => { stdout += d; });
  provider.child.stderr?.resume();
  return { provider, pidFile, dir, stdout: () => stdout };
}

describe('a stop ends the whole tree, and says so', () => {
  it('stdin and stdout are the provider\'s; the tree is reported; stop leaves no process of it', async () => {
    const { provider, pidFile, stdout } = launchTree();
    const tree = await provider.started;
    const pids = await pidsIn(pidFile, 3);
    expect(tree.providerPid).toBe(pids[0]);
    expect(tree.containment.kind).toBe(isWindows ? 'job-object' : 'process-group');
    expect(pids.every(alive)).toBe(true);

    provider.child.stdin?.write('ping\n');
    await until('echo', () => (stdout().includes('echo:ping') ? true : undefined));

    const verdict = await provider.stop({ graceMs: 200 });
    expect(verdict).toEqual({ graceful: false, empty: true, survivors: 0, verified: true });
    expect(pids.filter(alive)).toEqual([]);
  });

  it('a provider that exits within the grace is graceful, and its children still go', async () => {
    const { provider, pidFile } = launchTree({ EXIT_ON_EOF: '1' });
    await provider.started;
    const pids = await pidsIn(pidFile, 3);
    const exit = new Promise<number | null>((resolve) => provider.child.once('close', (code) => resolve(code)));

    const verdict = await provider.stop({ graceMs: 5_000 });
    expect(verdict).toEqual({ graceful: true, empty: true, survivors: 0, verified: true });
    expect(pids.filter(alive)).toEqual([]);
    expect(await exit).toBe(7);
  });

  it('a provider that ends on its own takes its leftover children with it, with no stop at all', async () => {
    const { provider, pidFile } = launchTree({ EXIT_ON_EOF: '1' });
    await provider.started;
    const pids = await pidsIn(pidFile, 3);
    const closed = new Promise<void>((resolve) => provider.child.once('close', () => resolve()));
    provider.child.stdin?.end();
    await closed;
    expect(pids.filter(alive)).toEqual([]);
  });

  it('kill() ends the tree too', async () => {
    const { provider, pidFile } = launchTree();
    await provider.started;
    const pids = await pidsIn(pidFile, 3);
    provider.kill();
    await until('the tree to end', () => (pids.some(alive) ? undefined : true), 5_000);
  });

  it.runIf(isWindows || process.platform === 'linux')('an ORPHANED detached grandchild still ends: the job on Windows, the cookie on Linux', async () => {
    const { provider, pidFile } = launchTree({ ORPHAN: '1' });
    await provider.started;
    const pids = await pidsIn(pidFile, 3);
    await until('level 1 to exit', () => (alive(pids[1]!) ? undefined : true));
    expect(alive(pids[2]!)).toBe(true);
    const verdict = await provider.stop({ graceMs: 100 });
    expect(verdict.empty).toBe(true);
    expect(pids.filter(alive)).toEqual([]);
  });
});

describe('the host dying ends the tree', () => {
  const dist = join(here, '..', 'dist', 'process-tree.js');

  it('a hard kill of the host process leaves nothing of the tree within 2 s', async () => {
    // A real host, so its death is real: it runs the BUILT package (CI builds before testing).
    expect(existsSync(dist), 'run `npm run build` first: this test runs the built package as the host').toBe(true);
    const dir = tmp();
    const pidFile = join(dir, 'pids');
    const host = join(dir, 'host.mjs');
    writeFileSync(host, [
      `import { launchProvider } from ${JSON.stringify(new URL(`file:///${dist.replace(/\\/g, '/')}`).href)};`,
      `const p = launchProvider(process.execPath, [${JSON.stringify(TREE)}, ${JSON.stringify(pidFile)}], { cwd: ${JSON.stringify(dir)}, env: process.env });`,
      'p.child.stdout.resume(); p.child.stderr.resume();',
      'p.started.then((tree) => console.log(JSON.stringify(tree)));',
      'setInterval(() => {}, 1 << 30);',
    ].join('\n'));
    const hostProcess = spawn(process.execPath, [host], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    hostProcess.stdout.on('data', (d) => { out += d; });
    const tree = await until('the host to report its tree', () => (out.includes('}') ? JSON.parse(out) : undefined), 20_000);
    const pids = await pidsIn(pidFile, 3);
    expect(tree.providerPid).toBe(pids[0]);
    expect(pids.every(alive)).toBe(true);

    if (isWindows) execFileSync('taskkill', ['/F', '/PID', String(hostProcess.pid)], { stdio: 'ignore' });
    else hostProcess.kill('SIGKILL');
    const started = Date.now();
    await until('the tree to end', () => (pids.some(alive) ? undefined : true), 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 30_000);
});

describe('the provider is run directly, never through a shell', () => {
  it('arguments arrive exactly, shell metacharacters included', async () => {
    const dir = tmp();
    const script = join(dir, 'argv.cjs');
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const args = ['plain', 'with space', 'quote"inside', 'trailing\\', 'trailing space\\ ', '', 'a&b|c>d %PATH% ^x', 'ünïcödé', '\\\\host\\share\\"x"', '$(echo hi)'];
    const provider = launchProvider(process.execPath, [script, ...args], { cwd: dir, env: process.env });
    launched.push(provider);
    let out = '';
    provider.child.stdout?.on('data', (d) => { out += d; });
    await new Promise<void>((resolve) => provider.child.once('close', () => resolve()));
    expect(JSON.parse(out)).toEqual(args);
  });

  it('a binary that does not exist is a failure to start, reported, not a hang', async () => {
    const dir = tmp();
    if (isWindows) {
      expect(() => launchProvider('prism-acp-no-such-binary', [], { cwd: dir, env: process.env })).toThrow(ProcessTreeError);
      return;
    }
    const provider = launchProvider('prism-acp-no-such-binary', [], { cwd: dir, env: process.env });
    const errors: Error[] = [];
    provider.child.on('error', (e) => errors.push(e));
    await expect(provider.started).rejects.toThrow(/failed to start the provider \((ENOENT|EACCES)\)/);
    await until('the error event', () => (errors.length > 0 ? true : undefined));
  });

  it('windowsCommandLine quotes only what needs it', () => {
    expect(windowsCommandLine(['C:\\a\\node.exe', 'x', 'a b', ''])).toBe('C:\\a\\node.exe x "a b" ""');
    expect(windowsCommandLine(['say "hi"'])).toBe('"say \\"hi\\""');
    expect(windowsCommandLine(['dir\\'])).toBe('dir\\');
    expect(windowsCommandLine(['a dir\\'])).toBe('"a dir\\\\"');
  });
});

describe.runIf(isWindows)('Windows: what a command name resolves to', () => {
  const NPM_SHIM = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    '',
  ].join('\r\n');

  function shimDir() {
    const bin = tmp();
    mkdirSync(join(bin, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    writeFileSync(join(bin, 'codex.cmd'), NPM_SHIM);
    return bin;
  }

  it('an npm shim runs as node + its script, with the shim\'s own node.exe when it has one', () => {
    const bin = shimDir();
    const nodeDir = dirname(process.execPath);
    const resolved = resolveWindowsCommand('codex', { PATH: `${bin};${nodeDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    expect(resolved.application.toLowerCase()).toBe(join(nodeDir, 'node.exe').toLowerCase());
    expect(resolved.args).toEqual([join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]);
    writeFileSync(join(bin, 'node.exe'), '');
    expect(resolveWindowsCommand('codex', { PATH: bin }).application).toBe(join(bin, 'node.exe'));
  });

  it('a batch file that is not an npm shim is refused, never run through cmd.exe', () => {
    const bin = tmp();
    writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nclaude-real.exe %*\r\n');
    expect(() => resolveWindowsCommand('claude', { PATH: bin })).toThrow(/not an npm shim/);
  });

  it('an .exe is itself; the current directory is never searched; a relative path is refused', () => {
    const bin = tmp();
    writeFileSync(join(bin, 'claude.exe'), '');
    expect(resolveWindowsCommand('claude', { PATH: bin }).application).toBe(join(bin, 'claude.exe'));
    const cwd = process.cwd();
    try {
      process.chdir(bin);
      expect(() => resolveWindowsCommand('claude', { PATH: '' })).toThrow(/not found/);
      expect(() => resolveWindowsCommand('.\\claude.exe', { PATH: '' })).toThrow(/absolute/);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('through the drivers, where a host enters', () => {
  /** A stand-in CLI: it ignores its arguments and starts the same tree, writing pids where PRISM_TEST_PIDS says. */
  function standIn(name: string) {
    const bin = tmp();
    const entry = `require(${JSON.stringify(TREE)});`;
    if (isWindows) {
      // An npm shim, exactly as npm writes one, so resolution runs end to end: no cmd.exe, node + the script.
      mkdirSync(join(bin, 'node_modules', 'stand-in'), { recursive: true });
      writeFileSync(join(bin, 'node_modules', 'stand-in', 'cli.js'), `process.argv.splice(2, process.argv.length, process.env.PRISM_TEST_PIDS);\n${entry}\n`);
      writeFileSync(join(bin, `${name}.cmd`), [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\stand-in\\cli.js" %*', '',
      ].join('\r\n'));
      return join(bin, `${name}.cmd`);
    }
    const file = join(bin, name);
    writeFileSync(file, `#!${process.execPath}\nprocess.argv.splice(2, process.argv.length, process.env.PRISM_TEST_PIDS);\n${entry}\n`, { mode: 0o755 });
    return file;
  }

  it('ClaudeDriver: stop() ends the CLI and everything it started, and processTree names it', async () => {
    const { ClaudeDriver } = await import('../src/claude/driver.js');
    const pidFile = join(tmp(), 'pids');
    const driver = new ClaudeDriver(
      { cwd: tmp(), binary: standIn('claude'), parentEnv: { ...process.env, PRISM_TEST_PIDS: pidFile }, allowEnv: ['PRISM_TEST_PIDS'] },
      {},
    );
    driver.start();
    const pids = await pidsIn(pidFile, 3);
    const tree = await until('the tree', () => driver.processTree ?? undefined);
    expect(tree.providerPid).toBe(pids[0]);
    const verdict = await driver.stop({ graceMs: 100 });
    expect(verdict).toMatchObject({ empty: true, survivors: 0, verified: true });
    expect(pids.filter(alive)).toEqual([]);
  });

  it('Codex transport: stop() ends app-server and everything it started', async () => {
    const { StdioCodexTransport } = await import('../src/codex/transport.js');
    const pidFile = join(tmp(), 'pids');
    const transport = new StdioCodexTransport(
      { cwd: tmp(), binary: standIn('codex'), env: { ...process.env, PRISM_TEST_PIDS: pidFile } as Record<string, string> },
      { onFrame: () => {}, onStderr: () => {}, onProblem: () => {}, onExit: () => {} },
    );
    await transport.start();
    const pids = await pidsIn(pidFile, 3);
    expect(transport.processTree?.providerPid).toBe(pids[0]);
    const verdict = await transport.stop({ graceMs: 100 });
    expect(verdict).toMatchObject({ empty: true, survivors: 0, verified: true });
    expect(pids.filter(alive)).toEqual([]);
  });

  it('a script provider runs as binary + binaryArgs: interpreter, script, then the provider\'s own arguments', async () => {
    const { StdioCodexTransport } = await import('../src/codex/transport.js');
    const dir = tmp();
    const argvFile = join(dir, 'argv.json');
    const script = join(dir, 'stub-codex.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nsetInterval(() => {}, 1 << 30);\n`);
    const transport = new StdioCodexTransport(
      { cwd: dir, binary: process.execPath, binaryArgs: [script], env: { ...process.env } as Record<string, string> },
      { onFrame: () => {}, onStderr: () => {}, onProblem: () => {}, onExit: () => {} },
    );
    await transport.start();
    const argv = await until('argv', () => (existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf8')) as string[] : undefined));
    expect(argv).toEqual(['app-server', '--listen', 'stdio://']);
    expect(await transport.stop({ graceMs: 100 })).toMatchObject({ empty: true, verified: true });
  });

  it('ClaudeDriver hands the CLI --settings and --mcp-config paths it can open as given (0.21.0 sent them quoted on Windows)', async () => {
    const { ClaudeDriver } = await import('../src/claude/driver.js');
    const dir = tmp();
    const argvFile = join(dir, 'argv.json');
    const script = join(dir, 'stub-claude.mjs');
    // Records its argv, and whether each path flag names a file it can actually read.
    writeFileSync(script, [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      "const opened = Object.fromEntries(['--settings', '--mcp-config'].map((flag) => [flag, existsSync(argv[argv.indexOf(flag) + 1])]));",
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv, opened }));`,
      'setInterval(() => {}, 1 << 30);',
    ].join('\n'));
    const driver = new ClaudeDriver({
      cwd: dir,
      binary: process.execPath,
      binaryArgs: [script],
      permissionPrompts: { tools: ['Bash'] },
      mcpServers: [{ name: 'probe', command: process.execPath, args: [], env: [] }],
    }, {});
    driver.start();
    const seen = await until('argv', () => (existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf8')) as {
      argv: string[]; opened: Record<string, boolean>;
    } : undefined));
    expect(seen.opened).toEqual({ '--settings': true, '--mcp-config': true });
    for (const flag of ['--settings', '--mcp-config']) expect(seen.argv[seen.argv.indexOf(flag) + 1]).not.toMatch(/^"|"$/);
    expect(await driver.stop({ graceMs: 100 })).toMatchObject({ empty: true });
  });
});
