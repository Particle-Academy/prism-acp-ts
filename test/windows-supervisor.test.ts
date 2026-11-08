import fs from 'node:fs';
import childProcess from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const system = vi.hoisted(() => ({ machine: 'x86_64', release: '10.0.22631', clr: true, missingAsset: false }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), machine: () => system.machine, release: () => system.release }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    if (String(args[0]).replaceAll('\\', '/').endsWith('FrameworkArm64/v4.0.30319/clr.dll')) {
      if (!system.clr) throw Object.assign(new Error('owned missing CLR'), { code: 'ENOENT' });
      return { isFile: () => true } as ReturnType<typeof actual.lstatSync>;
    }
    if (system.missingAsset && String(args[0]).endsWith('prism-acp-supervisor.exe')) throw Object.assign(new Error('owned quarantine'), { code: 'ENOENT' });
    return Reflect.apply(actual.lstatSync, actual, args);
  } };
});
let directory: string;
beforeEach(() => {
  vi.resetModules(); system.machine = 'x86_64'; system.release = '10.0.22631'; system.clr = true; system.missingAsset = false;
  directory = fs.mkdtempSync(join(tmpdir(), 'prism-shipped-supervisor-'));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const load = () => import('../src/windows-supervisor.js');

describe('shipped supervisor selection and immutable image pins', () => {
  it('resolves both package assets without compiling, copying or writing an executable', async () => {
    const { resolveWindowsSupervisor, packagedSupervisorPath } = await load();
    const compiler = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('compiler invocation forbidden'); });
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('runtime writes forbidden'); });
    expect(resolveWindowsSupervisor()).toBe(packagedSupervisorPath('x64'));
    expect(resolveWindowsSupervisor()).toBe(packagedSupervisorPath('x64'));
    expect(fs.statSync(packagedSupervisorPath('arm64')).size).toBeGreaterThan(512);
    expect(compiler).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it('accepts an explicit host-owned copy and copies the option value', async () => {
    const api = await load(), file = join(directory, 'host-owned.exe');
    fs.copyFileSync(api.packagedSupervisorPath('x64'), file);
    api.prepareWindowsSupervisor(file);
    expect(api.resolveWindowsSupervisor()).toBe(file);
  });
  it('accepts synthetic certificate/checksum changes without changing pinned program bytes', async () => {
    const api = await load(), bytes = fs.readFileSync(api.packagedSupervisorPath('x64'));
    const image = Buffer.concat([bytes, Buffer.alloc(24)]), optional = image.readUInt32LE(0x3c) + 24, security = optional + 112 + 32;
    image.writeUInt32LE(0x12345678, optional + 64); image.writeUInt32LE(bytes.length, security); image.writeUInt32LE(24, security + 4);
    image.writeUInt32LE(24, bytes.length); image.writeUInt16LE(0x0200, bytes.length + 4); image.writeUInt16LE(0x0002, bytes.length + 6);
    const file = join(directory, 'synthetic-table.exe'); fs.writeFileSync(file, image);
    api.prepareWindowsSupervisor(file); expect(api.resolveWindowsSupervisor()).toBe(file);
  });
  it('refuses code mutation and retains a failed override fence until explicitly repaired', async () => {
    const api = await load(), good = join(directory, 'good.exe'), bad = join(directory, 'bad.exe');
    const bytes = fs.readFileSync(api.packagedSupervisorPath('x64')); fs.writeFileSync(good, bytes); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(bad, bytes);
    expect(() => api.prepareWindowsSupervisor(bad)).toThrow(/does not match/);
    expect(() => api.resolveWindowsSupervisor()).toThrow(/configured supervisor was refused/);
    api.prepareWindowsSupervisor(good); expect(api.resolveWindowsSupervisor()).toBe(good);
  });
  it('rechecks the selected executable on every use and never repairs it by compilation', async () => {
    const api = await load(), file = join(directory, 'changed-later.exe'); fs.copyFileSync(api.packagedSupervisorPath('x64'), file);
    api.prepareWindowsSupervisor(file); const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
    const compiler = vi.spyOn(childProcess, 'execFileSync');
    expect(() => api.resolveWindowsSupervisor()).toThrow(/does not match/); expect(compiler).not.toHaveBeenCalled();
  });
  it('refuses an asset removed by quarantine without a fallback', async () => {
    const api = await load(); system.missingAsset = true;
    expect(() => api.resolveWindowsSupervisor()).toThrow(/unavailable/);
  });
  it('refuses an executable for the other architecture', async () => {
    const api = await load(); expect(() => api.prepareWindowsSupervisor(api.packagedSupervisorPath('arm64'))).toThrow(/does not match/);
  });
  it('refuses archive-contained paths with an actionable unpacked-copy instruction', async () => {
    const api = await load(); expect(() => api.prepareWindowsSupervisor(join(directory, 'app.asar', 'supervisor.exe'))).toThrow(/unpacked signed executable/);
  });
  it('requires an absolute explicit path', async () => {
    const api = await load(); expect(() => api.prepareWindowsSupervisor('relative.exe')).toThrow(/absolute/);
  });
  it('refuses an oversized or empty executable before parsing or launching it', async () => {
    const api = await load(), oversized = join(directory, 'oversized.exe'), empty = join(directory, 'empty.exe');
    fs.writeFileSync(oversized, Buffer.alloc(8 * 1024 * 1024 + 1)); fs.writeFileSync(empty, '');
    expect(() => api.prepareWindowsSupervisor(oversized)).toThrow(/invalid size/);
    expect(() => api.prepareWindowsSupervisor(empty)).toThrow(/invalid size/);
  });
  it('refuses a directory supplied as an executable', async () => {
    const api = await load(); expect(() => api.prepareWindowsSupervisor(directory)).toThrow(/regular file/);
  });
  it('snapshots the public executable option before its asynchronous yield', async () => {
    const api = await load(), file = join(directory, 'host-snapshot.exe'); fs.copyFileSync(api.packagedSupervisorPath('x64'), file);
    const { prepareProcessTree, windowsApprovalAdapter } = await import('../src/process-tree.js');
    const options = { executable: file }, pending = prepareProcessTree(options); options.executable = 'relative-and-refused.exe';
    await expect(pending).resolves.toBeUndefined(); expect(windowsApprovalAdapter()).toBe(file);
  });
  it('does not guess unsupported architectures', async () => {
    const api = await load(); system.machine = 'unknown'; expect(() => api.resolveWindowsSupervisor()).toThrow(/requires x64/);
    expect(() => api.packagedSupervisorPath('other' as 'x64')).toThrow(/unsupported/);
  });
  it('selects native ARM64 assets when the machine is ARM64', async () => {
    const api = await load(); system.machine = 'aarch64'; expect(api.resolveWindowsSupervisor()).toBe(api.packagedSupervisorPath('arm64'));
  });
  it.each(['10.0.19045', '6.3.9600', 'invalid'])('refuses unsupported ARM64 OS %s before launch', async version => {
    const api = await load(); system.machine = 'ARM64'; system.release = version;
    expect(() => api.resolveWindowsSupervisor()).toThrow(/Windows 11 with .NET Framework 4.8.1/);
  });
  it('refuses ARM64 when the native CLR4.8.1 installation is absent', async () => {
    const api = await load(); system.machine = 'ARM64'; system.clr = false; expect(() => api.resolveWindowsSupervisor()).toThrow(/4.8.1/);
  });
  it('keeps deprecated directory accepted, ignored and warned exactly once', async () => {
    const warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const { prepareProcessTree, supervisorPath } = await import('../src/process-tree.js');
    await prepareProcessTree({ directory: 'relative-and-unused' }); await prepareProcessTree({ directory: join(directory, 'unused') });
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('executable'), { code: 'PRISM_ACP_SUPERVISOR_DIRECTORY_DEPRECATED' });
    expect(fs.existsSync(join(directory, 'unused'))).toBe(false); expect(supervisorPath('x64')).toMatch(/win32-x64/);
  });
});
