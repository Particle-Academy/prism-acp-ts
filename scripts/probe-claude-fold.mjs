#!/usr/bin/env node
/**
 * MEASURE what the real Claude CLI emits when a prompt sent MID-TURN is folded into the running turn (G-266).
 *
 * Claude Code may attach a user message that arrives while a turn is running to that turn, instead of running it as
 * a turn of its own. ClaudeDriver must settle such a prompt from what the CLI actually reports, never from a timeout,
 * so this records every frame that carries a turn identity:
 *   - command_lifecycle frames (command_uuid, state);
 *   - user frames (uuid, and whether they echo one of our prompts);
 *   - result frames (user_message_uuid, subtype, num_turns);
 *   - any other frame naming one of our prompt UUIDs anywhere in its body.
 *
 * Prompt A asks for tool use, so the turn has a tool boundary to fold at. Prompt B is written once A's first tool_use
 * appears. The probe waits until both are accounted for or the stream is quiet for 45 s, then ends stdin.
 *
 * Uses a subscription turn or two on the signed-in `claude`:
 *
 *   npm run build && node scripts/probe-claude-fold.mjs [--cwd <dir>] [--binary <path>]
 *
 * Prints one JSON report on stdout. Exit 0 = the measurement completed (whatever it found); 2 = it could not run.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { childEnv, claudeArgs, encodeLine, NdjsonFramer } from '../dist/index.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const cwd = option('--cwd', process.cwd());
const binary = option('--binary', 'claude');
// --cancel: once B has started inside A's turn, send the interrupt ClaudeDriver.cancel() sends, and record its receipt.
const cancel = argv.includes('--cancel');
let cancelSentAt = null;
let receipt = null;

const { env } = childEnv(process.env, { allow: ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'] });
const child = spawn(binary, claudeArgs({ cwd }), { cwd, env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });

const start = Date.now();
const a = randomUUID();
const b = randomUUID();
const ours = new Set([a, b]);
const trace = [];
const results = [];
let version = null;
let bSentAt = null;
let lastFrame = Date.now();
const framer = new NdjsonFramer();

const user = (uuid, text) => encodeLine({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid });
const mentions = (value) => { const s = JSON.stringify(value); return [...ours].filter((id) => s.includes(id)).map((id) => (id === a ? 'A' : 'B')); };

child.stdout.on('data', (chunk) => {
  for (const frame of framer.push(chunk)) {
    if (!frame.ok) continue;
    const v = frame.value;
    lastFrame = Date.now();
    const at = Date.now() - start;
    if (v.type === 'system' && v.subtype === 'init') version = v.claude_code_version ?? null;
    if (v.type === 'stream_event') continue;
    const names = mentions(v);
    if (v.type === 'control_response') { receipt = v.response ?? null; const r = v.response?.response; trace.push({ at, type: 'control_response', subtype: v.response?.subtype, cancelled: (r?.cancelled ?? []).map((id) => (id === a ? 'A' : id === b ? 'B' : 'other')), still_queued: (r?.still_queued ?? []).map((id) => (id === a ? 'A' : id === b ? 'B' : 'other')), keys: Object.keys(r ?? {}) }); continue; }
    if (cancel && cancelSentAt === null && v.type === 'command_lifecycle' && v.command_uuid === b && v.state === 'started') { cancelSentAt = at; child.stdin.write(encodeLine({ type: 'control_request', request_id: 'probe-interrupt-1', request: { subtype: 'interrupt', cancel_queued: true } })); trace.push({ at, type: 'SENT', control: 'interrupt' }); }
    if (v.type === 'command_lifecycle') trace.push({ at, type: v.type, command: v.command_uuid === a ? 'A' : v.command_uuid === b ? 'B' : 'other', state: v.state, keys: Object.keys(v) });
    else if (v.type === 'result') { const r = { at, type: 'result', for: v.user_message_uuid === a ? 'A' : v.user_message_uuid === b ? 'B' : (v.user_message_uuid ?? 'absent'), subtype: v.subtype, stop_reason: v.stop_reason, num_turns: v.num_turns, is_error: v.is_error, terminal_reason: v.terminal_reason, user_message_uuids: Array.isArray(v.user_message_uuids) ? v.user_message_uuids.map((id) => (id === a ? 'A' : id === b ? 'B' : 'other')) : v.user_message_uuids, queued_turn_count: v.queued_turn_count, result_index: v.result_index, keys: Object.keys(v) }; trace.push(r); results.push(r); }
    else if (v.type === 'user') trace.push({ at, type: 'user', uuid: v.uuid === a ? 'A' : v.uuid === b ? 'B' : 'other', toolResult: Array.isArray(v.message?.content) && v.message.content.some((c) => c.type === 'tool_result'), isReplay: v.isReplay ?? null, names, keys: Object.keys(v) });
    else if (v.type === 'assistant') {
      const tools = (v.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.name);
      trace.push({ at, type: 'assistant', tools, names });
      if (tools.length > 0 && bSentAt === null) { bSentAt = at; child.stdin.write(user(b, 'Also: when you finish, add one final line that says exactly FOLD-CHECK-B.')); trace.push({ at, type: 'SENT', prompt: 'B' }); }
    } else trace.push({ at, type: v.type, subtype: v.subtype, names });
  }
});
child.stderr.setEncoding('utf8');
const stderr = [];
child.stderr.on('data', (c) => stderr.push(c));
child.on('error', (cause) => { process.stdout.write(`${JSON.stringify({ ran: false, reason: `spawn failed: ${cause.message}` })}\n`); process.exit(2); });

child.stdin.write(user(a, `Use the Read tool to read ${cwd.replace(/\\/g, '/')}/package.json, then use it again to read ${cwd.replace(/\\/g, '/')}/README.md (first 40 lines), then summarise both in about 150 words.`));
trace.push({ at: 0, type: 'SENT', prompt: 'A' });

const done = () => (results.some((r) => r.for === 'B') && results.some((r) => r.for === 'A')) || (cancel ? results.length > 0 && receipt !== null : results.some((r) => r.user_message_uuids?.includes?.('B')));
const timer = setInterval(() => {
  if (done() || Date.now() - lastFrame > 45_000 || Date.now() - start > 240_000) {
    clearInterval(timer);
    child.stdin.end();
    setTimeout(() => {
      child.kill();
      process.stdout.write(`${JSON.stringify({ ran: true, claude_code_version: version, measuredAt: new Date().toISOString(), bSentAt, cancel, cancelSentAt, receipt: receipt === null ? null : { subtype: receipt.subtype }, results, trace, stderrTail: stderr.join('').slice(-800) }, null, 2)}\n`);
      process.exit(0);
    }, 3_000);
  }
}, 500);
