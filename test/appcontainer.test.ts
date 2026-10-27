import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareProcessTree } from '../src/process-tree.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
let root: string, foreign: string, executable: string;

// Creates temporary OS profiles; opt in explicitly. CI enables this on Windows.
describe.runIf(process.platform === 'win32' && process.env.PRISM_ACP_APPCONTAINER === '1')('public launch inside a real AppContainer (Windows; PRISM_ACP_APPCONTAINER=1)', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'prism-acp-container-')); roots.push(root);
    foreign = mkdtempSync(join(tmpdir(), 'prism-acp-foreign-')); roots.push(foreign);
    for (const directory of ['program', 'workspace', 'home']) mkdirSync(join(root, directory));
    writeFileSync(join(foreign, 'owned-secret'), 'owned-foreign-marker');
    copyFileSync(process.execPath, join(root, 'program', 'node.exe'));
    cpSync(resolve(here, '../dist'), join(root, 'program', 'dist'), { recursive: true });
    copyFileSync(join(here, 'fixtures', 'appcontainer-worker.mjs'), join(root, 'program', 'worker.mjs'));
    copyFileSync(join(here, 'fixtures', 'appcontainer-target.mjs'), join(root, 'program', 'target.mjs'));
    if (process.env.PRISM_ACP_CLAUDE_RESTRICTED === '1') {
      if (!process.env.PRISM_ACP_CLAUDE_BINARY) throw new Error('Set PRISM_ACP_CLAUDE_BINARY to native Claude2.1.311');
      copyFileSync(process.env.PRISM_ACP_CLAUDE_BINARY, join(root, 'program', 'claude.exe'));
      for (const file of ['claude-restricted-loopback.mjs', 'claude-restricted-mcp.mjs']) copyFileSync(join(here, 'fixtures', file), join(root, 'program', file));
    }
    executable = join(root, 'program', 'fixture-host.exe');
    const csc = join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    await exec(csc, ['-nologo', '-optimize+', '-target:exe', `-out:${executable}`, join(here, 'fixtures', 'appcontainer-host.cs')], { windowsHide: true, timeout: 20_000 });
    await prepareProcessTree({ directory: join(root, 'program', 'supervisor') });
    const stalled = join(root, 'program', 'stalled-supervisor'); mkdirSync(stalled);
    const source = join(stalled, 'owned-stall.cs');
    writeFileSync(source, 'static class OwnedStall { static void Main() { System.Threading.Thread.Sleep(10000); } }');
    const stalledExe = join(stalled, 'prism-acp-supervisor.exe');
    await exec(csc, ['-nologo', '-target:exe', `-out:${stalledExe}`, source], { windowsHide: true, timeout: 20_000 });
    const stalledHash = createHash('sha256').update(readFileSync(stalledExe)).digest('hex');
    renameSync(stalledExe, join(stalled, `prism-acp-supervisor-${stalledHash}.exe`));
    writeFileSync(join(stalled, 'prism-acp-supervisor.current.sha256'), stalledHash);
    const exiting = join(root, 'program', 'exiting-supervisor'); mkdirSync(exiting);
    const exitSource = join(exiting, 'owned-exit.cs'), exitExe = join(exiting, 'prism-acp-supervisor.exe');
    writeFileSync(exitSource, 'static class OwnedExit { static int Main() { return 123; } }');
    await exec(csc, ['-nologo', '-target:exe', `-out:${exitExe}`, exitSource], { windowsHide: true, timeout: 20_000 });
    const exitHash = createHash('sha256').update(readFileSync(exitExe)).digest('hex');
    renameSync(exitExe, join(exiting, `prism-acp-supervisor-${exitHash}.exe`));
    writeFileSync(join(exiting, 'prism-acp-supervisor.current.sha256'), exitHash);
    writeFileSync(join(root, 'program', 'owned-invalid.exe'), 'owned invalid executable; must never run');
  }, 60_000);
  afterAll(() => {
    const temporary = realpathSync(tmpdir());
    for (const path of roots) {
      const target = realpathSync(path);
      if (dirname(target) !== temporary || !/^prism-acp-(?:container|foreign)-/.test(basename(target))) throw new Error('refusing cleanup outside owned temporary roots');
      rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  async function probe(mode: string, timeout = 5000) {
    for (const file of ['tree-pids', 'proof-pids', 'proof-ack']) rmSync(join(root, 'workspace', file), { force: true });
    const result = await exec(executable, [root, join(root, 'program', 'node.exe'), join(root, 'program', 'worker.mjs'), mode, join(foreign, 'owned-secret'), String(timeout)], {
      timeout: timeout + 10_000, maxBuffer: 128_000, windowsHide: true,
    });
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    expect(lines.find((line) => line.fixture === 'identity')?.appContainer).toBe(true);
    expect(lines.find((line) => line.stage === 'foreign_refused')).toBeDefined();
    expect(lines.find((line) => line.stage === 'assigned_write')).toBeDefined();
    expect(readFileSync(join(root, 'workspace', 'owned-marker'), 'utf8')).toBe('owned');
    const final = lines.find((line) => line.fixture === 'result');
    if (final?.workerExit !== 0) lines.push({ ownedDiagnostic: result.stderr });
    expect(final).toMatchObject({ verified: true, empty: true, profileRemoved: true, foreignProfileRemoved: true });
    return { lines, final };
  }

  it('distinguishes forbidden libuv pipe names from supported LOCAL names', async () => {
    const { lines, final } = await probe('native');
    expect(lines.filter((line) => line.stage === 'native_pipe' && !line.local).map((line) => line.error)).toEqual([5, 5, 5]);
    expect(lines.filter((line) => line.stage === 'native_pipe' && line.local).map((line) => line.error)).toEqual([0, 0, 0]);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0 });
  }, 20_000);

  it.runIf(process.env.PRISM_ACP_CLAUDE_RESTRICTED === '1')('starts native Claude2.1.311 with supplied stdio MCP inside the unchanged zero-capability container', async () => {
    const { lines, final } = await probe('claude-native-mcp', 15_000);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0, descendantsVerified: 3 });
    expect(lines.find(line => line.stage === 'native_mcp_reports')?.reports).toEqual([{ name: 'owned', status: 'connected', toolCount: 1 }]);
    expect(lines.find(line => line.stage === 'native_mcp_protocol')?.methods).toEqual(expect.arrayContaining(['initialize', 'tools/list']));
    expect(lines.find(line => line.stage === 'stop')?.verdict).toMatchObject({ verified: true, empty: true, survivors: 0 });
  }, 30_000);

  it('protects generated configuration with only the user and actual container SID, without shell-outs', async () => {
    const { lines, final } = await probe('private-config');
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    expect(lines.find(line => line.stage === 'private_config_created')).toBeDefined();
    expect(lines.find(line => line.fixture === 'private_acl')).toMatchObject({ protected: true, principals: 2 });
    expect(lines.find(line => line.fixture === 'private_file_acl')).toMatchObject({ inherited: true, principals: 2 });
    expect(lines.find(line => line.fixture === 'private_foreign_access')).toMatchObject({ readableControl: true, privateDenied: true });
    expect(lines.find(line => line.fixture === 'private_foreign_identity')).toMatchObject({ appContainer: true });
  }, 20_000);

  it('diagnoses a native private operation under inherited fixture stdio', async () => {
    const { lines, final } = await probe('private-probe');
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    expect(lines.find(line => line.stage === 'native_private_diagnostic')).toMatchObject({ status: 0 });
  }, 20_000);

  it.each(['present', 'missing', 'retargeted'])('requires the actual effective TEMP parent: %s', async mode => {
    const { lines, final } = await probe('private-temp-' + mode, 10_000);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    expect(lines.find(line => line.stage === 'private_temp')).toMatchObject({ refused: mode === 'missing', parentExists: mode !== 'missing', providerStarted: mode !== 'missing' });
    expect(lines.find(line => line.stage === 'stop')?.verdict).toMatchObject({ empty: true, verified: true, survivors: 0 });
  }, 25_000);

  it.each(['inherit', 'ignore'])('measures %s stdio without global-pipe creation', async mode => {
    const { lines, final } = await probe(mode);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    if (mode === 'ignore' && lines.some(line => line.stage === 'ignore_refused')) {
      expect(lines.find(line => line.stage === 'ignore_refused')?.code).toBe('EPERM');
    } else expect(lines.find(line => line.stage === 'spawn_returned')).toBeDefined();
  }, 20_000);

  it('launches through the public local-pipe contract and verifies a complete stop', async () => {
    const { lines, final } = await probe('local');
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0 });
    expect(lines.find((line) => line.stage === 'launch_returned')).toBeDefined();
    expect(lines.find((line) => line.stage === 'provider_started')?.tree.containment.kind).toBe('job-object');
    expect(lines.find((line) => line.stage === 'stdout')?.text.trim()).toBe(process.version);
    expect(lines.find((line) => line.stage === 'stop')?.verdict).toMatchObject({ verified: true, empty: true, survivors: 0 });
  }, 20_000);

  it('preserves arbitrary byte I/O and observes stdin backpressure', async () => {
    const { lines, final } = await probe('bytes');
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    const bytes = lines.find((line) => line.stage === 'bytes');
    expect(bytes.actual).toBe(bytes.expected);
    expect(bytes.length).toBe(2 * 1024 * 1024 + 3);
    expect(bytes.stderr).toBe('00ff80410a');
    expect(bytes.buffered).toBeLessThanOrEqual(65_536);
  }, 20_000);

  it('verifies all three descendant tokens and stops the detached tree', async () => {
    const { lines, final } = await probe('tree');
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, descendantsVerified: 3, remainingBeforeCleanup: 0 });
    expect(lines.find((line) => line.stage === 'survivors')?.pids).toEqual([]);
    expect(lines.find((line) => line.stage === 'stop')?.verdict).toMatchObject({ empty: true, verified: true, survivors: 0 });
  }, 20_000);

  it('host death empties the job before the outer fixture performs cleanup', async () => {
    const { lines, final } = await probe('death');
    expect(lines.find((line) => line.stage === 'tree_ready')?.pids).toHaveLength(3);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, descendantsVerified: 3, remainingBeforeCleanup: 0 });
  }, 20_000);

  it.each(['driver-claude', 'driver-codex', 'models-claude', 'models-codex'])('supports %s with the public processTree option', async mode => {
    const { lines, final } = await probe(mode);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    expect(lines.find((line) => line.stage === 'models')?.models.availableModels).toHaveLength(1);
    if (mode.startsWith('driver-')) expect(lines.find((line) => line.stage === 'stop')?.verdict).toMatchObject({ empty: true, verified: true, survivors: 0 });
  }, 20_000);

  it('bounds startup when a trusted supervisor does not complete the protocol', async () => {
    const { lines, final } = await probe('deadline');
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    const deadline = lines.find((line) => line.stage === 'deadline');
    expect(deadline?.elapsed).toBeLessThan(1500);
    expect(deadline?.message).toContain('startup deadline exceeded');
    expect(lines.find((line) => line.stage === 'provider_started')).toBeUndefined();
    expect(lines.find((line) => line.stage === 'stop')?.verdict).toMatchObject({ empty: true, verified: false, survivors: null });
  }, 20_000);

  it('inherits only protected user/container pipe ACLs, with no broad grants', async () => {
    const { lines, final } = await probe('acl');
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    const stdout = lines.filter(line => line.stage === 'stdout').map(line => line.text).join('');
    expect(stdout, JSON.stringify(lines)).not.toBe('');
    expect(lines.find(line => line.stage === 'acl_diagnostic')?.exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ stage: 'stdio_acl', protected: true, principals: 2, pipes: 3 });
  }, 20_000);

  it.each(['stall-input', 'stall-output'])('bounds %s and empties the tree', async mode => {
    const { lines, final } = await probe(mode);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    expect(lines.find(line => line.stage === 'io_deadline')?.elapsed).toBeLessThan(2000);
  }, 20_000);

  it.each(['native-failure', 'early-exit'])('reports %s without bootstrap Console streams or a silent hang', async mode => {
    const { lines, final } = await probe(mode);
    expect(final, JSON.stringify(lines)).toMatchObject({ timedOut: false, workerExit: 0, remainingBeforeCleanup: 0 });
    const failure = lines.find(line => line.stage === 'supervisor_failure');
    expect(failure?.elapsed).toBeLessThan(2500);
    if (mode === 'native-failure') {
      // The Windows loader reports bad format or machine-type mismatch for
      // this owned non-PE file; both are native errors carried by control.
      expect(failure?.message).toMatch(/native launch failed: (?:193|216)\)/);
    } else expect(failure?.message).toContain('supervisor ended before provider startup (exit 123)');
    expect(lines.find(line => line.stage === 'provider_started')).toBeUndefined();
  }, 20_000);
});
