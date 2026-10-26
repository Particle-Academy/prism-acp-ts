import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const [mode, file, level = '0'] = process.argv.slice(2);
if (Object.keys(process.env).some(name => /^PRISM_ACP_TREE_(?:CHANNEL|TOKEN|IO_\d)$/i.test(name) || /^OPENAI_API_KEY$/i.test(name))) {
  throw new Error('owned fixture received a reserved environment variable');
}
if (mode === 'stall-input') {
  setInterval(() => {}, 60_000);
} else if (mode === 'stall-output') {
  const fill = () => { while (process.stdout.write(Buffer.alloc(16384, 42))) {} };
  process.stdout.on('drain', fill); fill();
} else if (mode === 'echo') {
  process.stdin.on('data', (bytes) => {
    if (!process.stdout.write(bytes)) {
      process.stdin.pause(); process.stdout.once('drain', () => process.stdin.resume());
    }
  });
  process.stdin.once('end', () => process.stderr.write(Buffer.from([0, 255, 128, 65, 10])));
} else if (mode === 'tree') {
  appendFileSync(file, process.pid + '\n');
  if (Number(level) < 2) {
    // No libuv pipe creation or NUL open: both can be denied to this token.
    const unused = openSync(fileURLToPath(import.meta.url), 'r');
    let child;
    try { child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', fileURLToPath(import.meta.url), mode, file, String(Number(level) + 1)], {
      stdio: [unused, unused, unused], detached: level === '1',
    }); } finally { closeSync(unused); }
    child.unref();
  }
  setInterval(() => {}, 60_000);
} else if (mode === 'claude' || mode === 'codex') {
  const lines = createInterface({ input: process.stdin });
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (mode === 'claude' && frame.type === 'control_request') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: { models: [{ value: 'default', displayName: 'Owned fixture model' }] } } });
    } else if (mode === 'codex' && frame.id !== undefined) {
      let result = {};
      if (frame.method === 'thread/start') result = { thread: { id: 'owned-thread' }, model: 'owned-model' };
      else if (frame.method === 'model/list') result = { data: [{ id: 'owned-model', model: 'owned-model', displayName: 'Owned fixture model', isDefault: true }], nextCursor: null };
      else if (frame.method === 'account/rateLimits/read') result = { ordinaryUsageAllowed: true, rateLimits: { primary: null, secondary: null } };
      send({ jsonrpc: '2.0', id: frame.id, result });
    }
  });
}
