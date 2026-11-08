import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { authenticodeImage } from '../../dist/authenticode.js';
const [cwd, ready, go, executable] = process.argv.slice(2);
let compilerAttempts = 0, executableWrites = 0;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = function(command, ...args) {
    if (/(?:^|[\\/])(?:csc|dotnet|powershell|pwsh)(?:\.exe)?$/i.test(String(command))) {
      compilerAttempts++; throw Error('runtime compiler/shell invocation forbidden');
    }
    return Reflect.apply(original, this, [command, ...args]);
  };
}
for (const name of ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'linkSync']) {
  const original = fs[name];
  fs[name] = function(...args) {
    const destination = ['copyFileSync', 'renameSync', 'linkSync'].includes(name) ? args[1] : args[0];
    if (/\.exe$/i.test(String(destination))) { executableWrites++; throw Error('runtime executable write forbidden'); }
    return Reflect.apply(original, this, args);
  };
}
syncBuiltinESMExports();
const { prepareProcessTree, launchProvider, windowsApprovalAdapter, createWindowsPrivateDirectory } = await import('../../dist/process-tree.js');
fs.writeFileSync(ready, 'ready');
while (!fs.existsSync(go)) await new Promise(resolve => setTimeout(resolve, 5));
const providers = [];
try {
  await prepareProcessTree(executable ? { executable } : {});
  const adapter = windowsApprovalAdapter(), digest = authenticodeImage(fs.readFileSync(adapter));
  const stops = [];
  for (const local of [false, true]) {
    const provider = launchProvider(process.execPath, ['-e', "process.stdout.write('OWN_READY\\n');setInterval(()=>{},1000)"], { cwd, env: process.env, ...(local ? { windowsStdio: 'local-pipes' } : {}) });
    providers.push(provider); const io = provider.io ?? provider.child;
    let output = ''; io.stdout.on('data', chunk => { output += String(chunk); }); io.stderr.resume();
    await provider.started;
    const deadline = Date.now() + 5000;
    while (!output.includes('OWN_READY\n')) { if (Date.now() > deadline) throw Error('native provider never became ready'); await new Promise(resolve => setTimeout(resolve, 5)); }
    const stop = await provider.stop({ graceMs: 0 });
    if (!stop.verified || !stop.empty || stop.survivors !== 0) throw Error('native provider tree was not verified empty');
    stops.push(stop);
  }
  const allow = childProcess.spawnSync(adapter, ['approval', process.execPath, '-e', "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));process.exit(42)", 'node'], { input: '{}', encoding: 'utf8', timeout: 5000, windowsHide: true });
  // Approval expects an existing JS script path, so use owned scripts rather than changing the adapter ABI.
  const allowScript = join(cwd, 'allow-' + process.pid + '.cjs'), denyScript = join(cwd, 'deny-' + process.pid + '.cjs');
  fs.writeFileSync(allowScript, "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));process.exit(42)");
  fs.writeFileSync(denyScript, 'process.exit(0)');
  const allowed = childProcess.spawnSync(adapter, ['approval', process.execPath, allowScript, 'node'], { input: '{}', encoding: 'utf8', timeout: 5000, windowsHide: true });
  const denied = childProcess.spawnSync(adapter, ['approval', process.execPath, denyScript, 'node'], { input: '{}', encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (allow.status !== 2 || allowed.status !== 0 || denied.status !== 2) throw Error('native approval changed its fail-closed allow42/deny0 contract');
  const privateDirectory = join(cwd, 'private-' + process.pid); createWindowsPrivateDirectory(privateDirectory);
  if (!fs.statSync(privateDirectory).isDirectory()) throw Error('native private directory was not created');
  if (compilerAttempts !== 0 || executableWrites !== 0) throw Error('runtime tried to compile or write executable code');
  console.log(JSON.stringify({ shippedWorker: true, success: true, architecture: digest.architecture, imageSha256: digest.sha256, stops, approval: { malformedExit: allow.status, allowExit: allowed.status, denyExit: denied.status }, privateDirectory: true, compilerAttempts, executableWrites }));
} catch (cause) {
  console.log(JSON.stringify({ shippedWorker: true, success: false, name: cause?.name, message: cause?.message, compilerAttempts, executableWrites })); process.exitCode = 1;
} finally {
  for (const provider of providers) await provider.stop({ graceMs: 0 });
}
