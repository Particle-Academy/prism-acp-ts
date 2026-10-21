#!/usr/bin/env node
/**
 * MEASURE what the real Claude CLI answers to the control `initialize` request, and whether `set_model` works on a live
 * process (tynn, Genie's model picker, 2026-10-21).
 *
 * The Agent SDK documents `Query.supportedModels()` and `SDKControlInitializeResponse`
 * (https://code.claude.com/docs/en/agent-sdk/typescript) but not the wire body of the request that produces them. This
 * sends `{ type: 'control_request', request_id, request: { subtype: 'initialize' } }` before any prompt and REPORTS the
 * control_response: its keys, the model entries' fields, and the account's model list. It then sends
 * `{ subtype: 'set_model', model }` and checks, with ONE short turn, which model actually answered.
 *
 *   npm run build && node scripts/probe-claude-models.mjs [--cwd <dir>] [--binary <path>] [--switch-to <model>]
 *
 * Prints one JSON report on stdout. Exit 0 = the measurement completed (whatever it found); 2 = it could not run.
 */
import { spawn } from 'node:child_process';
import { childEnv, claudeArgs, encodeLine, NdjsonFramer, promptLine } from '../dist/index.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const cwd = option('--cwd', process.cwd());
const binary = option('--binary', 'claude');
const switchTo = option('--switch-to', 'haiku');

const { env } = childEnv(process.env, { allow: ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'] });
const child = spawn(binary, claudeArgs({ cwd }), { cwd, env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });

const frames = [];
let exited = null;
const framer = new NdjsonFramer();
child.stdout.on('data', (chunk) => {
  for (const frame of framer.push(chunk)) if (frame.ok) frames.push(frame.value);
});
child.stderr.resume();
child.on('exit', (code, signal) => { exited = { code, signal }; });
child.on('error', (cause) => {
  process.stdout.write(`${JSON.stringify({ ran: false, reason: `spawn failed: ${cause.message}` }, null, 2)}\n`);
  process.exit(2);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready, ms) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline || exited !== null) return false;
    await sleep(50);
  }
  return true;
}
const response = (id) => frames.find((f) => f?.type === 'control_response' && (f.response?.request_id === id || f.request_id === id));

const report = { ran: true };
try {
  const startedAt = Date.now();
  child.stdin.write(encodeLine({ type: 'control_request', request_id: 'probe-init-1', request: { subtype: 'initialize' } }));
  report.initializeAnswered = await until(() => response('probe-init-1') !== undefined, 60_000);
  report.msToInitializeResponse = Date.now() - startedAt;
  const init = response('probe-init-1');
  report.initializeEnvelopeKeys = init ? Object.keys(init) : null;
  report.initializeResponseKeys = init?.response ? Object.keys(init.response) : null;
  const inner = init?.response?.response ?? init?.response;
  report.initializeInnerKeys = inner && typeof inner === 'object' ? Object.keys(inner) : null;
  report.models = inner?.models ?? null;
  report.modelEntryKeys = Array.isArray(inner?.models) && inner.models[0] ? Object.keys(inner.models[0]) : null;
  report.framesBeforePrompt = frames.map((f) => `${f?.type}/${f?.subtype ?? f?.response?.subtype ?? ''}`);

  child.stdin.write(encodeLine({ type: 'control_request', request_id: 'probe-set-model-1', request: { subtype: 'set_model', model: switchTo } }));
  await until(() => response('probe-set-model-1') !== undefined, 30_000);
  report.setModelResponse = response('probe-set-model-1') ?? null;

  child.stdin.write(promptLine('Reply with exactly: OK'));
  await until(() => frames.some((f) => f?.type === 'result'), 120_000);
  const sysInit = frames.find((f) => f?.type === 'system' && f?.subtype === 'init');
  report.cliVersion = sysInit?.claude_code_version ?? null;
  report.modelOnSystemInit = sysInit?.model ?? null;
  const assistant = frames.find((f) => f?.type === 'assistant');
  report.modelThatAnswered = assistant?.message?.model ?? null;
  const result = frames.find((f) => f?.type === 'result');
  report.resultModelUsage = result?.modelUsage ? Object.keys(result.modelUsage) : null;
} catch (cause) {
  report.error = String(cause?.message ?? cause);
} finally {
  child.stdin.end();
  child.kill();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(0);
