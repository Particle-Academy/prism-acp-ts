// Build-time tool only. Never imported by the runtime, invoked by an install
// script, or used as an on-machine fallback. Candidate binaries originate in CI.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SUPERVISOR_CS } from '../../dist/process-tree-supervisor-cs.js';
import { authenticodeImage } from '../../dist/authenticode.js';

assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? ''), 'Supervisor binaries may only be built by Windows GitHub Actions; no local compiler fallback');
const SDK = '10.0.403';
const RUNTIME = '10.0.14';
const requested = process.argv[2];
assert(requested && path.isAbsolute(requested), 'Explicit absolute CI output directory required');
const parent = fs.realpathSync(process.env.RUNNER_TEMP), output = path.resolve(requested), relative = path.relative(parent, output);
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Output must stay inside this CI run temporary directory');
assert(!fs.existsSync(output), 'Refuse to replace an earlier build');
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1', DOTNET_MULTILEVEL_LOOKUP: '0', DOTNET_ROLL_FORWARD: 'Disable' };
function command(args, cwd = process.cwd()) {
  const result = spawnSync('dotnet', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
assert.equal(command(['--version']), SDK, 'Compiler SDK must match the reviewed exact version');
const sdkEntry = command(['--list-sdks']).split(/\r?\n/).map(line => /^([^ ]+) \[(.*)\]$/.exec(line)).find(entry => entry?.[1] === SDK);
assert(sdkEntry, 'Reviewed SDK was not found');
const sdkRoot = path.join(sdkEntry[2], SDK), compiler = path.join(sdkRoot, 'Roslyn/bincore/csc.dll');
const references = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Reference Assemblies/Microsoft/Framework/.NETFramework/v4.8');
const referenceNames = ['mscorlib.dll', 'System.dll', 'System.Core.dll'];
for (const file of [compiler, ...referenceNames.map(name => path.join(references, name))]) assert(fs.statSync(file).isFile());
for (const root of [output, references, sdkRoot]) assert(!/[,=\r\n]/.test(root), 'Unsupported path-map input');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(output);
const source = path.join(output, 'Supervisor.cs');
fs.writeFileSync(source, SUPERVISOR_CS, { flag: 'wx' });
const manifest = {
  schemaVersion: 1,
  sourceSha256: sha256(Buffer.from(SUPERVISOR_CS, 'utf8')),
  toolchain: { sdk: SDK, runtime: RUNTIME, compilerSha256: sha256(fs.readFileSync(compiler)), references: referenceNames.map(name => ({ file: name, sha256: sha256(fs.readFileSync(path.join(references, name))) })) },
  binaries: {},
};
for (const architecture of ['x64', 'arm64']) {
  const directory = path.join(output, 'win32-' + architecture);
  fs.mkdirSync(directory);
  const executable = path.join(directory, 'prism-acp-supervisor.exe');
  const args = ['exec', '--fx-version', RUNTIME, compiler, '-nologo', '-noconfig', '-nostdlib+', '-deterministic+', '-optimize+', '-debug-', '-target:exe', '-langversion:5', '-preferreduilang:en-US', '-codepage:65001', '-platform:' + architecture,
    '-pathmap:' + output + '=/__prism__,' + references + '=/__refs__,' + sdkRoot + '=/__sdk__',
    '-out:' + executable, ...referenceNames.map(name => '-reference:' + path.join(references, name)), source];
  const log = command(args, output);
  fs.writeFileSync(path.join(output, architecture + '-compiler.log'), log + '\n', { flag: 'wx' });
  const bytes = fs.readFileSync(executable), digest = authenticodeImage(bytes);
  assert.equal(digest.architecture, architecture);
  assert.equal(digest.certificateBytes, 0, 'Reproducibility is checked on unsigned bytes, before optional signing');
  manifest.binaries[architecture] = { file: 'win32-' + architecture + '/prism-acp-supervisor.exe', bytes: bytes.length, sha256: sha256(bytes), authenticodeSha256: digest.sha256 };
}
fs.writeFileSync(path.join(output, 'supervisor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ supervisorCandidate: { sdk: SDK, sourceSha256: manifest.sourceSha256, manifestSha256: sha256(fs.readFileSync(path.join(output, 'supervisor-manifest.json'))), architectures: Object.keys(manifest.binaries) } }));
