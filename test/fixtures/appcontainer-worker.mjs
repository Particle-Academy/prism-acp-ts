import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { prepareProcessTree, launchProvider, ClaudeDriver, CodexDriver, listModels } from './dist/index.js';

const [root, mode, foreign] = process.argv.slice(2);
const say = (stage, detail = {}) => process.stdout.write(JSON.stringify({ stage, ...detail }) + '\n');
say('host_started');
try { readFileSync(foreign); say('foreign_read'); process.exit(2); }
catch (error) { say('foreign_refused', { code: error.code }); }
writeFileSync(root + '/workspace/owned-marker', 'owned');
writeFileSync(root + '/home/owned-marker', 'owned');
say('assigned_write');

if (mode === 'native') {
  const child = spawn(process.env.PRISM_FIXTURE_NATIVE, ['--pipe-probe'], { stdio: 'inherit' });
  child.once('exit', (code) => process.exit(code ?? 1));
} else if (['inherit', 'ignore', 'pipe'].includes(mode)) {
  say('before_spawn');
  let child;
  try { child = spawn(process.execPath, ['--version'], { stdio: mode === 'pipe' ? ['ignore', 'pipe', 'pipe'] : mode }); }
  catch (error) {
    // This is a measured baseline, not the supported transport. Some restricted
    // Windows hosts also deny libuv's NUL open; the public path must avoid it.
    if (mode !== 'ignore' || error.code !== 'EPERM') throw error;
    say('ignore_refused', { code: error.code }); process.exit(0);
  }
  say('spawn_returned');
  child.stdout?.on('data', (bytes) => say('stdout', { text: String(bytes) }));
  child.stderr?.resume();
  child.once('exit', (code) => process.exit(code ?? 1));
} else if (mode === 'deadline') {
  await prepareProcessTree({ directory: root + '/program/stalled-supervisor' });
  const started = Date.now();
  const provider = launchProvider(process.execPath, ['--version'], { cwd: root + '/workspace', env: process.env, windowsStdio: 'local-pipes', startupTimeoutMs: 150 });
  try { await provider.started; process.exitCode = 5; }
  catch (error) { say('deadline', { elapsed: Date.now() - started, message: error.message }); }
  say('stop', { verdict: await provider.stop({ graceMs: 0 }) });
} else if (mode.startsWith('driver-') || mode.startsWith('models-')) {
  await prepareProcessTree({ directory: root + '/program/supervisor' });
  const kind = mode.endsWith('claude') ? 'claude' : 'codex';
  const options = { cwd: root + '/workspace', binary: process.execPath,
    binaryArgs: ['--preserve-symlinks', '--preserve-symlinks-main', root + '/program/target.mjs', kind],
    parentEnv: { ...process.env, OPENAI_API_KEY: 'owned-key-must-be-withheld' },
    processTree: { windowsStdio: 'local-pipes', startupTimeoutMs: 2000 } };
  try {
    if (mode.startsWith('models-')) {
      const models = await listModels(kind, options); say('models', { models });
    } else {
      const driver = kind === 'claude' ? new ClaudeDriver(options) : new CodexDriver(options);
      driver.start(); const models = await driver.modelState(); say('models', { models });
      say('stop', { verdict: await driver.stop({ graceMs: 1000 }) });
    }
  } catch (error) { say('error', { name: error.name, message: error.message }); process.exitCode = 4; }
} else {
  await prepareProcessTree({ directory: root + '/program/supervisor' });
  say('supervisor_prepared');
  const target = root + '/program/target.mjs';
  const args = mode === 'acl' ? ['--pipe-acl']
    : mode.startsWith('stall-') ? ['--preserve-symlinks', '--preserve-symlinks-main', target, mode]
    : mode === 'bytes' ? ['--preserve-symlinks', '--preserve-symlinks-main', target, 'echo']
    : ['tree', 'death'].includes(mode) ? ['--preserve-symlinks', '--preserve-symlinks-main', target, 'tree', root + '/workspace/tree-pids']
    : ['--version'];
  const provider = launchProvider(mode === 'acl' ? process.env.PRISM_FIXTURE_NATIVE : process.execPath, args, {
    cwd: root + '/workspace', env: process.env,
    ...(['local', 'bytes', 'tree', 'death', 'acl', 'stall-input', 'stall-output'].includes(mode) ? { windowsStdio: 'local-pipes', startupTimeoutMs: 2000, ...(mode.startsWith('stall-') ? { ioTimeoutMs: 150 } : {}) } : {}),
  });
  say('launch_returned');
  const io = provider.io ?? provider.child;
  const output = [], errors = [];
  if (mode !== 'stall-output') io.stdout?.on('data', (bytes) => { if (mode === 'bytes') output.push(Buffer.from(bytes)); else say('stdout', { text: String(bytes) }); });
  io.stderr?.on('data', (bytes) => errors.push(Buffer.from(bytes)));
  try {
    const tree = await provider.started;
    say('provider_started', { tree });
    if (mode.startsWith('stall-')) {
      const time = Date.now();
      if (mode === 'stall-input') io.stdin.write(Buffer.alloc(4 * 1024 * 1024));
      await provider.closed;
      say('io_deadline', { elapsed: Date.now() - time, tree });
      say('stop', { verdict: await provider.stop({ graceMs: 0 }) });
      process.exit(0);
    }
    let pids = [];
    if (mode === 'bytes') {
      const payload = Buffer.alloc(2 * 1024 * 1024 + 3);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
      let buffered = 0;
      for (let i = 0; i < payload.length; i += 16384) {
        const accepted = io.stdin.write(payload.subarray(i, i + 16384));
        buffered = Math.max(buffered, io.stdin.writableLength);
        if (!accepted) await once(io.stdin, 'drain');
      }
      io.stdin.end(); await provider.closed;
      say('bytes', { expected: createHash('sha256').update(payload).digest('hex'), actual: createHash('sha256').update(Buffer.concat(output)).digest('hex'),
        length: Buffer.concat(output).length, stderr: Buffer.concat(errors).toString('hex'), buffered });
    }
    if (mode === 'tree' || mode === 'death') {
      const wait = async (check) => { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) throw new Error('owned fixture deadline'); await new Promise(r => setTimeout(r, 10)); } };
      const file = root + '/workspace/tree-pids';
      await wait(() => existsSync(file) && readFileSync(file, 'utf8').trim().split('\n').length === 3);
      pids = readFileSync(file, 'utf8').trim().split('\n').map(Number);
      if (!pids.includes(tree.providerPid)) throw new Error('owned provider PID mismatch');
      writeFileSync(root + '/workspace/proof-pids', pids.join('\n') + '\n');
      await wait(() => existsSync(root + '/workspace/proof-ack'));
      say('tree_ready', { pids });
      if (mode === 'death') { await new Promise(resolve => process.stdout.write('', resolve)); process.kill(process.pid, 'SIGKILL'); }
    }
    const verdict = await provider.stop({ graceMs: mode === 'tree' ? 0 : 1000 });
    say('stop', { verdict });
    if (mode === 'acl') say('acl_diagnostic', { exit: provider.child.exitCode, stderr: Buffer.concat(errors).toString() });
    if (pids.length !== 0) say('survivors', { pids: pids.filter(pid => { try { process.kill(pid, 0); return true; } catch(error) { return error.code !== 'ESRCH'; } }) });
    if (!verdict.verified || !verdict.empty || verdict.survivors !== 0) process.exitCode = 3;
  } catch (error) { say('error', { name: error.name, message: error.message }); process.exitCode = 4; }
}
