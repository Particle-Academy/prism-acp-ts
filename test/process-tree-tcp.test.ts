import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prepareProcessTree, windowsCommandLine } from '../src/process-tree.js';
import { TcpHost, alive, delay, until } from './helpers/supervisor-tcp-host.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'prism-tcp-supervisor-'));
const executable = join(directory, 'prism-acp-supervisor.exe');
const hosts: TcpHost[] = [];
const children: ChildProcess[] = [];
const fixturePids = new Set<number>();
const pidFiles: string[] = [];
let nextPidFile = 0;
const treeFixture = join(here, 'fixtures', 'process-tree.cjs');
const bytesFixture = join(here, 'fixtures', 'supervisor-bytes.cjs');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const spec = (script: string, args: string[] = []) => [
  'spawn', b64(process.execPath), b64(windowsCommandLine([process.execPath, script, ...args])), b64(directory),
].join(' ');
const pidsIn = async (file: string) => {
  const pids = await until(() => {
    const ids = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
    return ids.length === 3 ? ids : undefined;
  }, 'three real fixture pids');
  for (const pid of pids) fixturePids.add(pid);
  return pids as number[];
};
const open = async (options = {}) => {
  const host = await TcpHost.open(executable, { cwd: directory, ...options });
  hosts.push(host);
  return host;
};
const treeSpec = () => {
  const file = join(directory, `pids-${nextPidFile++}`);
  pidFiles.push(file);
  return { file, line: spec(treeFixture, [file]) };
};
afterAll(() => { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

describe.runIf(process.platform === 'win32')('optional TCP supervisor mode', () => {
  beforeAll(async () => { await prepareProcessTree({ directory }); }, 60_000);
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
    // Include PIDs written even when an assertion failed before pidsIn() returned.
    for (const file of pidFiles.splice(0)) if (existsSync(file)) {
      for (const value of readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)) fixturePids.add(Number(value));
    }
    for (const pid of fixturePids) if (alive(pid)) {
      // Failure cleanup only; every successful containment assertion precedes it and checks the OS itself.
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fixturePids.clear();
  });
  it('stop removes the provider, its child and its DETACHED grandchild by PID', async () => {
    const host = await open();
    const { file, line } = treeSpec();
    const provider = await host.launch(line);
    const pids = await pidsIn(file);
    expect(pids).toContain(provider);
    expect(pids.every(alive)).toBe(true);
    expect(await host.stop()).toBe(0);
    expect(pids.filter(alive)).toEqual([]);
    expect(alive(host.child.pid)).toBe(false);
  }, 20_000);

  it('control EOF removes a detached tree while the host is still alive', async () => {
    const host = await open();
    const { file, line } = treeSpec();
    await host.launch(line);
    const pids = await pidsIn(file);
    host.control.destroy();
    await host.closed.promise;
    expect(pids.filter(alive)).toEqual([]);
  }, 20_000);

  it('hard-killing only the host removes the detached tree and the detached supervisor', async () => {
    const { file, line } = treeSpec();
    const child = spawn(process.execPath, [join(here, 'helpers', 'supervisor-tcp-host.mjs'), '--host', executable, directory, b64(line)], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', (data) => { stdout += data; });
    child.stderr!.on('data', (data) => { stderr += data; });
    const tree = await until(() => {
      if (child.exitCode !== null) throw new Error(`host startup failed: ${stderr}`);
      return stdout.includes('\n') ? JSON.parse(stdout) as { supervisorPid: number; providerPid: number } : undefined;
    }, 'external host handshake', 15_000);
    const pids = await pidsIn(file);
    expect(pids).toContain(tree.providerPid);
    expect(pids.every(alive)).toBe(true);
    // No /T: no recursive taskkill and no stop sent to the supervisor.
    execFileSync(join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), ['/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    await until(() => !alive(tree.supervisorPid) && pids.every((pid) => !alive(pid)) ? true : undefined, 'all tree PIDs to disappear', 5_000);
    expect(pids.filter(alive)).toEqual([]);
  }, 30_000);

  it('refuses a wrong control token before any provider is started', async () => {
    const host = await open({ controlAuth: '0'.repeat(64) });
    const { file, line } = treeSpec();
    // Attempt a valid spawn as well: merely withholding the spec would also exit 125 if authentication were broken.
    await host.sendSpec(line);
    expect(await Promise.race([host.closed.promise, host.started.promise.then(() => 'provider started')])).toBe(125);
    expect(host.lines.some((line: string) => line.startsWith('started '))).toBe(false);
    expect(existsSync(file)).toBe(false);
  }, 15_000);

  it('drops a peer that connects but never authenticates', async () => {
    const host = await open({ controlAuth: false });
    await host.hello.promise;
    const started = Date.now();
    expect(await host.closed.promise).toBe(125);
    expect(Date.now() - started).toBeGreaterThan(1_000);
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(host.lines).toEqual([]);
  }, 15_000);

  it('does not extend the authentication deadline for a slow partial line', async () => {
    const host = await open({ controlAuth: false });
    await host.hello.promise;
    const timer = setInterval(() => host.control.write('a'), 200);
    try {
      const start = Date.now();
      expect(await host.closed.promise).toBe(125);
      expect(Date.now() - start).toBeLessThan(9_000);
    } finally { clearInterval(timer); }
  }, 15_000);

  it('refuses an oversized authentication line', async () => {
    const host = await open({ controlAuth: '0'.repeat(129) });
    await host.hello.promise;
    expect(await host.closed.promise).toBe(125);
    expect(host.lines).toEqual([]);
  }, 15_000);

  it.each([0, 1, 2])('requires the correct token and role on stdio %i before spawn', async (fd) => {
    const host = await open({ stdioAuth: { [fd]: '0'.repeat(64) } });
    const { file, line } = treeSpec();
    await host.sendSpec(line);
    expect(await Promise.race([host.closed.promise, host.started.promise.then(() => 'provider started')])).toBe(125);
    expect(host.headers.has(fd)).toBe(true);
    expect(host.lines.some((line: string) => line.startsWith('started '))).toBe(false);
    expect(existsSync(file)).toBe(false);
  }, 15_000);

  it('times out an unauthenticated stdio stream before spawn', async () => {
    const host = await open({ stdioAuth: { 1: false } });
    const { file, line } = treeSpec();
    await host.sendSpec(line);
    expect(await host.closed.promise).toBe(125);
    expect(host.headers.has(1)).toBe(true);
    expect(existsSync(file)).toBe(false);
  }, 15_000);

  it('refuses a valid stdio token acknowledged for the wrong role', async () => {
    const host = await open({ stdioRole: { 0: 1 } });
    const { file, line } = treeSpec();
    await host.sendSpec(line);
    expect(await Promise.race([host.closed.promise, host.started.promise.then(() => 'provider started')])).toBe(125);
    expect(existsSync(file)).toBe(false);
  }, 15_000);

  it.each([
    ['invalid command', Buffer.from('surprise\n')],
    ['invalid base64', Buffer.from('spawn ! ! !\n')],
    ['missing field', Buffer.from('spawn YQ== Yg==\n')],
    ['non-ASCII', Buffer.from([0xff, 10])],
    ['NUL', Buffer.from('spawn\0 anything\n')],
    ['oversized line', Buffer.from('x'.repeat(262_145) + '\n')],
  ])('refuses %s in the control specification', async (_label, bytes) => {
    const host = await open();
    await host.sendSpec(bytes);
    expect(await host.closed.promise).toBe(125);
    expect(host.lines.some((line: string) => line.startsWith('started '))).toBe(false);
    expect(host.io.filter(Boolean)).toEqual([]);
  }, 15_000);

  it.each([
    ['relative application', 'relative.exe', b64('relative.exe')],
    ['decoded NUL', `${process.execPath}\0`, b64(process.execPath)],
    ['malformed UTF-8', process.execPath, Buffer.from([0xc0, 0xaf]).toString('base64')],
  ])('refuses %s in a decoded spawn field', async (_label, application, command) => {
    const host = await open();
    await host.sendSpec(`spawn ${b64(application)} ${command} ${b64(directory)}`);
    expect(await host.closed.promise).toBe(125);
    expect(host.io.filter(Boolean)).toEqual([]);
  }, 15_000);

  it.each([['unknown command', 'surprise\n'], ['oversized command', 'x'.repeat(262_145) + '\n']])('%s after spawn ends the job', async (_label, command) => {
    const host = await open();
    const { file, line } = treeSpec();
    await host.launch(line);
    const pids = await pidsIn(file);
    host.control.write(command);
    expect(await host.empty.promise).toBe(0);
    await host.closed.promise;
    expect(host.lines).toContain('failed control');
    expect(pids.filter(alive)).toEqual([]);
  }, 20_000);

  it('bounds a partial command coalesced with the spawn line', async () => {
    const host = await open();
    const { file, line } = treeSpec();
    await host.sendSpec(Buffer.from(`${line}\nk`));
    await host.started.promise;
    const pids = await pidsIn(file);
    const result = await Promise.race([host.empty.promise, delay(7_500).then(() => 'no partial-line deadline')]);
    expect(result).toBe(0);
    await host.closed.promise;
    expect(host.lines).toContain('failed control');
    expect(pids.filter(alive)).toEqual([]);
  }, 20_000);

  it('keeps authenticated control and input idle beyond the handshake deadline', async () => {
    const host = await open();
    const { file, line } = treeSpec();
    await host.launch(line);
    const pids = await pidsIn(file);
    await delay(5_300);
    expect(pids.every(alive)).toBe(true);
    expect(host.child.exitCode).toBeNull();
    host.io[0].write('ping\n');
    await until(() => Buffer.concat(host.stdout).includes('echo:ping') ? true : undefined, 'unbuffered stdin echo');
    expect(await host.stop()).toBe(0);
    expect(pids.filter(alive)).toEqual([]);
  }, 20_000);

  it('preserves binary data coalesced with stdin authentication, fragmented input and final output', async () => {
    const first = Buffer.from([0, 255, 10, 13, 128, 0, 42]);
    const rest = Buffer.from('raw bytes: \u0000雪\r\nlast');
    const input = Buffer.concat([first, rest]);
    const host = await open({ initialStdin: first });
    await host.launch(spec(bytesFixture));
    host.io[0].write(rest.subarray(0, 3));
    await delay(30);
    host.io[0].end(rest.subarray(3));
    expect(await host.closed.promise).toBe(0);
    await Promise.all([host.ioEnded[1].promise, host.ioEnded[2].promise]);
    expect(host.lines).toContain('empty 0');
    expect(Buffer.concat(host.stdout)).toEqual(input);
    expect(Buffer.concat(host.stderr)).toEqual(Buffer.from(input.map((byte) => byte ^ 0xff)));
  }, 20_000);

  it('preserves a large binary burst on all three streams while both output readers apply backpressure', async () => {
    const input = Buffer.allocUnsafe(8 * 1024 * 1024 + 37);
    for (let i = 0; i < input.length; i++) input[i] = i % 256;
    const host = await open({ pauseOutputs: true });
    await host.launch(spec(bytesFixture));
    host.io[0].write(input);
    host.io[0].end();
    await delay(300);
    expect(host.child.exitCode).toBeNull();
    expect(host.stdout).toEqual([]);
    expect(host.stderr).toEqual([]);
    host.io[1].resume(); host.io[2].resume();
    expect(await host.closed.promise).toBe(0);
    await Promise.all([host.ioEnded[1].promise, host.ioEnded[2].promise]);
    const stdout = Buffer.concat(host.stdout);
    expect(stdout.length).toBe(input.length);
    expect(stdout.equals(input), 'stdout bytes').toBe(true);
    const expected = Buffer.from(input);
    for (let i = 0; i < expected.length; i++) expected[i] ^= 0xff;
    const stderr = Buffer.concat(host.stderr);
    expect(stderr.length).toBe(expected.length);
    expect(stderr.equals(expected), 'stderr bytes').toBe(true);
    expect(host.lines).toContain('empty 0');
  }, 30_000);
});
