import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { machine, release } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticodeImage } from './authenticode.js';

export type WindowsSupervisorArchitecture = 'x64' | 'arm64';
export class NativeSupervisorError extends Error {
  override readonly name = 'NativeSupervisorError';
}
const fail = (message: string): never => { throw new NativeSupervisorError(message); };
const assetRoot = fileURLToPath(new URL('../native/', import.meta.url));
let override: string | null = null;
let blocked = false;

/** Physical machine architecture, so an emulated host never chooses an emulated supervisor fallback. */
function architecture(): WindowsSupervisorArchitecture {
  const value = machine().toLowerCase();
  if (value === 'x86_64' || value === 'amd64') return 'x64';
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  return fail('the native Windows supervisor requires x64 Windows 10/11 or ARM64 Windows 11 with .NET Framework 4.8.1');
}

export function packagedSupervisorPath(arch: WindowsSupervisorArchitecture = architecture()): string {
  if (arch !== 'x64' && arch !== 'arm64') return fail('unsupported Windows supervisor architecture; use x64 or arm64');
  return join(assetRoot, 'win32-' + arch, 'prism-acp-supervisor.exe');
}

/** Bounded handle reads; a growing file cannot cause an unbounded readFile allocation. */
function readBounded(file: string, limit: number): Buffer {
  let descriptor: number | undefined;
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) return fail('the supervisor asset must be a regular file');
    descriptor = openSync(file, 'r');
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > limit) return fail('the supervisor asset has an invalid size');
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(descriptor, bytes, position, bytes.length - position, position);
      if (count === 0) return fail('the supervisor asset changed while it was read');
      position += count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return fail('the supervisor asset changed while it was read');
    return bytes;
  } catch (cause) {
    if (cause instanceof NativeSupervisorError) throw cause;
    return fail('the shipped supervisor is unavailable; install the complete package or pass an unpacked executable to prepareProcessTree');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function pin(arch: WindowsSupervisorArchitecture): { bytes: number; digest: string } {
  try {
    const value = JSON.parse(readBounded(join(assetRoot, 'supervisor-manifest.json'), 64 * 1024).toString('utf8')) as Record<string, any>;
    const record = value.binaries?.[arch];
    if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.sourceSha256) || record?.file !== 'win32-' + arch + '/prism-acp-supervisor.exe'
      || !Number.isSafeInteger(record.bytes) || record.bytes < 512 || record.bytes > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(record.authenticodeSha256)) return fail('the shipped supervisor pin is invalid; reinstall the complete package');
    return { bytes: record.bytes, digest: record.authenticodeSha256 };
  } catch (cause) {
    if (cause instanceof NativeSupervisorError) throw cause;
    return fail('the shipped supervisor pin is invalid; reinstall the complete package');
  }
}

function supportFloor(arch: WindowsSupervisorArchitecture): void {
  const parts = release().split('.').map(Number);
  if (arch === 'x64') {
    if (!Number.isInteger(parts[0]) || parts[0] < 10) fail('the native x64 supervisor requires Windows 10 or Windows 11 with the installed CLR4; no provider was started');
    return;
  }
  const clr = join(process.env.SystemRoot ?? process.env.windir ?? 'C:/Windows', 'Microsoft.NET/FrameworkArm64/v4.0.30319/clr.dll');
  let installed = false;
  try { installed = lstatSync(clr).isFile(); } catch { /* The native CLR is absent. */ }
  if (parts[0] !== 10 || !Number.isInteger(parts[2]) || parts[2] < 22000 || !installed) fail('the native ARM64 supervisor requires Windows 11 with .NET Framework 4.8.1 (included in 22H2+); no provider was started');
}

function verify(file: string, arch: WindowsSupervisorArchitecture): string {
  if (!isAbsolute(file) || file.includes('\0')) return fail('the supervisor executable must be an absolute regular-file path');
  if (/\.asar(?:[\\/]|$)/i.test(file)) return fail('the shipped supervisor is inside an archive; pass its unpacked signed executable to prepareProcessTree');
  const expected = pin(arch);
  try {
    const image = authenticodeImage(readBounded(file, 8 * 1024 * 1024));
    if (image.architecture !== arch || image.bodyBytes !== expected.bytes || image.sha256 !== expected.digest) return fail('the supervisor executable does not match the shipped Authenticode pin; no provider was started');
    return file;
  } catch (cause) {
    if (cause instanceof NativeSupervisorError) throw cause;
    return fail('the supervisor executable has an invalid PE image; no provider was started');
  }
}

/** Explicit host configuration, copied before use. A refused override never falls back to another executable. */
export function prepareWindowsSupervisor(executable?: string): void {
  const arch = architecture(); supportFloor(arch);
  if (executable !== undefined) {
    blocked = true;
    if (typeof executable !== 'string') return fail('the supervisor executable must be an absolute regular-file path');
    override = executable;
    verify(override, arch);
    blocked = false;
  } else resolveWindowsSupervisor();
}

export function resolveWindowsSupervisor(): string {
  if (blocked) return fail('the configured supervisor was refused; prepare a valid unpacked executable before launching a provider');
  const arch = architecture(); supportFloor(arch);
  return verify(override ?? packagedSupervisorPath(arch), arch);
}
