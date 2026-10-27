import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { prepareProcessTree, launchProvider, ClaudeDriver, CodexDriver, listModels } from './dist/index.js';
import { createWindowsPrivateDirectory } from './dist/process-tree.js';

const [root, mode, foreign] = process.argv.slice(2);
const say = (stage, detail = {}) => process.stdout.write(JSON.stringify({ stage, ...detail }) + '\n');
say('host_started');
try { readFileSync(foreign); say('foreign_read'); process.exit(2); }
catch (error) { say('foreign_refused', { code: error.code }); }
writeFileSync(root + '/workspace/owned-marker', 'owned');
writeFileSync(root + '/home/owned-marker', 'owned');
say('assigned_write');

if (mode === 'claude-native-mcp') {
  await prepareProcessTree({ directory: root + '/program/supervisor' });
  const home = root + '/home/owned-provider'; mkdirSync(home);
  const marker = root + '/workspace/owned-mcp-methods';
  say('native_private_location', { insideOwnedRoot: tmpdir().replaceAll('\\', '/').toLowerCase().startsWith(root.replaceAll('\\', '/').toLowerCase() + '/'), exists: existsSync(tmpdir()) });
  let finish, refuse;
  const announced = new Promise((resolve, reject) => { finish = resolve; refuse = reject; });
  announced.catch(() => {});
  const driver = new ClaudeDriver({ cwd: root + '/workspace', binary: process.execPath,
    binaryArgs: ['--preserve-symlinks', '--preserve-symlinks-main', root + '/program/claude-restricted-loopback.mjs', root + '/program/claude.exe', 'http://127.0.0.1:1', root + '/workspace/owned-native-launch.json'],
    parentEnv: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
    allowEnv: ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'],
    credentials: { mode: 'apiKey', apiKey: 'owned-restricted-synthetic-key', home }, nativeTools: 'none', model: 'claude-sonnet-4-6',
    mcpServers: [{ name: 'owned', command: process.execPath, args: ['--preserve-symlinks', '--preserve-symlinks-main', root + '/program/claude-restricted-mcp.mjs', marker], env: [] }],
    processTree: { windowsStdio: 'local-pipes', startupTimeoutMs: 2000 },
  }, { onProtocolError: reason => refuse(new Error(reason)), onUpdate: update => { if (update.sessionUpdate === 'notice' && update.notice?.message === 'session started') finish(); } });
  let timer;
  try {
    driver.start(); driver.prompt('Owned startup-only MCP discovery fixture.');
    await driver.modelState();
    await Promise.race([announced, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned native discovery deadline')), 10_000); })]);
    say('native_mcp_reports', { reports: driver.mcpServers });
    const rows = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    say('native_mcp_protocol', { methods: rows.map(row => row.method) });
    writeFileSync(root + '/workspace/proof-pids', [driver.processTree.providerPid, rows[0].ppid, rows[0].pid].join('\n') + '\n');
    const deadline = Date.now() + 2000;
    while (!existsSync(root + '/workspace/proof-ack')) {
      if (Date.now() > deadline) throw new Error('owned native descendant identity deadline');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } catch (error) { say('error', { name: error.name, message: error.message, stderr: driver.stderr.slice(-2000) }); process.exitCode = 4; }
  finally { clearTimeout(timer); say('stop', { verdict: await driver.stop({ graceMs: 0 }) }); }
} else if (mode.startsWith('private-temp-')) {
  await prepareProcessTree({ directory: root + '/program/supervisor' });
  const missing = mode === 'private-temp-missing';
  const parent = tmpdir();
  if (!parent.replaceAll('\\', '/').toLowerCase().startsWith((root + '/home/').replaceAll('\\', '/').toLowerCase())) throw new Error('effective fixture TEMP escaped its owned home');
  const marker = root + '/workspace/private-temp-provider-' + mode;
  const driver = new ClaudeDriver({ cwd: root + '/workspace', binary: process.execPath,
    binaryArgs: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"owned");process.stdin.resume();setInterval(()=>{},60000)', marker],
    parentEnv: process.env, nativeTools: 'none', processTree: { windowsStdio: 'local-pipes', startupTimeoutMs: 2000 },
  });
  let refused = false, config;
  try {
    try { driver.start(); }
    catch (error) {
      if (!missing || !error.message.includes('effective TEMP') || !error.message.includes('host must provision') || error.message.includes(root) || driver.processTree !== null) throw error;
      refused = true;
    }
    if (missing) {
      if (!refused || existsSync(parent) || existsSync(marker)) throw new Error('missing fixture TEMP did not refuse before launch');
    } else {
      config = parent + '/' + readdirSync(parent).find(name => name.startsWith('prism-acp-mcp-')) + '/mcp.json';
      if (!existsSync(config)) throw new Error('protected fixture config missing');
      const deadline = Date.now() + 5000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error('owned fixture provider did not start');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    say('private_temp', { refused, parentExists: existsSync(parent), providerStarted: existsSync(marker) });
  } finally {
    const verdict = await driver.stop({ graceMs: 0 }); say('stop', { verdict });
    if (config !== undefined && existsSync(config)) throw new Error('protected fixture config survived stop');
  }
} else if (mode === 'private-probe') {
  await prepareProcessTree({ directory: root + '/program/supervisor' });
  const directory = root + '/home/owned-native-probe';
  const hash = readFileSync(root + '/program/supervisor/prism-acp-supervisor.current.sha256', 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('owned native probe digest invalid');
  const result = spawnSync(root + '/program/supervisor/prism-acp-supervisor-' + hash + '.exe', ['--create-private-directory', directory], { stdio: 'inherit', windowsHide: true, timeout: 5000 });
  say('native_private_diagnostic', { status: result.status, signal: result.signal, spawnCode: result.error?.code });
  process.exitCode = result.status === 0 ? 0 : 3;
} else if (mode === 'private-config') {
  await prepareProcessTree({ directory: root + '/program/supervisor' });
  const directory = root + '/home/owned-private';
  createWindowsPrivateDirectory(directory);
  writeFileSync(directory + '/mcp.json', JSON.stringify({ owned: 'synthetic-mcp-header' }), { flag: 'wx', mode: 0o600 });
  say('private_config_created');
} else if (mode === 'native') {
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
} else if (mode === 'native-failure' || mode === 'early-exit') {
  await prepareProcessTree({ directory: root + '/program/' + (mode === 'early-exit' ? 'exiting-supervisor' : 'supervisor') });
  const time = Date.now();
  const provider = launchProvider(mode === 'native-failure' ? root + '/program/owned-invalid.exe' : process.execPath, [], {
    cwd: root + '/workspace', env: process.env, windowsStdio: 'local-pipes', startupTimeoutMs: 2000,
  });
  provider.io.stdout.resume(); provider.io.stderr.resume();
  try { await provider.started; say('provider_started'); process.exitCode = 5; }
  catch (error) { say('supervisor_failure', { elapsed: Date.now() - time, message: error.message }); }
  await provider.closed;
  say('stop', { verdict: await provider.stop({ graceMs: 0 }) });
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
