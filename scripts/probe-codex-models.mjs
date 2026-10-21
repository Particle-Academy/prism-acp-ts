#!/usr/bin/env node
/**
 * MEASURE what the real Codex app-server answers to `model/list` (tynn, Genie's model picker, 2026-10-21).
 *
 * The method and its shape are in the app-server's own schema (`codex app-server generate-json-schema`:
 * ModelListParams { cursor?, limit?, includeHidden? } -> ModelListResponse { data: Model[], nextCursor? }). This runs
 * the documented handshake (initialize, initialized), pages through `model/list`, and reports every model's id, model,
 * displayName, description, isDefault and hidden. No thread is started and no turn runs.
 *
 *   npm run build && node scripts/probe-codex-models.mjs [--binary <path>] [--include-hidden]
 *
 * Prints one JSON report on stdout. Exit 0 = the measurement completed; 2 = it could not run.
 */
import { spawn } from 'node:child_process';
import { childEnv, encodeLine, NdjsonFramer } from '../dist/index.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const binary = option('--binary', 'codex');
const includeHidden = argv.includes('--include-hidden');

const { env } = childEnv(process.env, { allow: ['CODEX_HOME', 'CODEX_CONFIG_DIR', 'XDG_CONFIG_HOME'] });
const child = spawn(binary, ['app-server', '--listen', 'stdio://'], { env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
child.on('error', (cause) => {
  process.stdout.write(`${JSON.stringify({ ran: false, reason: `spawn failed: ${cause.message}` }, null, 2)}\n`);
  process.exit(2);
});

const framer = new NdjsonFramer();
const waiting = new Map();
child.stdout.on('data', (chunk) => {
  for (const frame of framer.push(chunk)) {
    if (!frame.ok) continue;
    const id = frame.value?.id;
    if (id !== undefined && waiting.has(id) && frame.value.method === undefined) {
      waiting.get(id)(frame.value);
      waiting.delete(id);
    }
  }
});
let next = 0;
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++next;
  const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
  waiting.set(id, (value) => { clearTimeout(timer); resolve(value); });
  child.stdin.write(encodeLine({ jsonrpc: '2.0', id, method, params }));
});

const report = { ran: true };
try {
  await request('initialize', { clientInfo: { name: 'prism-acp-probe', version: '0' }, capabilities: {} });
  child.stdin.write(encodeLine({ jsonrpc: '2.0', method: 'initialized' }));
  const models = [];
  let cursor = null;
  let pages = 0;
  do {
    const answer = await request('model/list', { cursor, includeHidden });
    if (answer.error) { report.error = answer.error; break; }
    pages += 1;
    report.firstEntryKeys ??= answer.result?.data?.[0] ? Object.keys(answer.result.data[0]) : null;
    for (const model of answer.result?.data ?? []) {
      models.push({ id: model.id, model: model.model, displayName: model.displayName, description: model.description, isDefault: model.isDefault, hidden: model.hidden });
    }
    cursor = answer.result?.nextCursor ?? null;
  } while (cursor !== null && pages < 20);
  report.pages = pages;
  report.models = models;
} catch (cause) {
  report.error = String(cause?.message ?? cause);
} finally {
  child.stdin.end();
  child.kill();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(0);
