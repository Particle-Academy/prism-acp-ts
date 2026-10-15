#!/usr/bin/env node
/**
 * MEASURE what the real Claude CLI does with an interrupt sent over `--input-format stream-json` (issue #16).
 *
 * ClaudeDriver.cancel() is BUILT on this measurement. The Agent SDK docs name an `interrupt` control request a client
 * may drive directly, and document its `{ type: "control_request", request_id, request }` envelope, but do not
 * document the `request` body that names it
 * (https://code.claude.com/docs/en/agent-sdk/typescript -- SDKControlInterruptResponse, SDKControlInitializeResponse).
 * This sends that body, `{ subtype: "interrupt" }`, and REPORTS what happens. First run 2026-10-15 on the owner's
 * Claude Code: accepted; error_during_execution / aborted_streaming result 11 ms later; process alive; the queued
 * message and the next prompt both ran. Re-run it when the CLI changes, and compare.
 *
 * It records:
 *   - the `capabilities` the CLI advertises on system/init (interrupt_receipt_v1, interrupt_cancel_queued_v1);
 *   - the control_response to the interrupt (success, receipt, or error);
 *   - the interrupted turn's result frame: subtype, stop_reason, terminal_reason, is_error;
 *   - whether the process is still alive afterwards;
 *   - what happened to a user message queued on stdin at the moment of the interrupt;
 *   - whether the next prompt runs to a normal finish.
 *
 * Uses a subscription turn or three on the signed-in `claude`. Run on a machine where that is acceptable:
 *
 *   npm run build && node scripts/probe-claude-interrupt.mjs [--cwd <dir>] [--binary <path>]
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

const { env } = childEnv(process.env, { allow: ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'] });
const child = spawn(binary, claudeArgs({ cwd }), {
  cwd,
  env,
  shell: process.platform === 'win32',
  stdio: ['pipe', 'pipe', 'pipe'],
});

const frames = [];
const stderr = [];
let exited = null;
const framer = new NdjsonFramer();
child.stdout.on('data', (chunk) => {
  for (const frame of framer.push(chunk)) if (frame.ok) frames.push({ at: Date.now(), value: frame.value });
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderr.push(chunk));
child.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; });
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
const values = () => frames.map((frame) => frame.value);
const results = () => values().filter((value) => value?.type === 'result');
const summary = (result) => result === undefined ? null : {
  subtype: result.subtype ?? null,
  stop_reason: result.stop_reason ?? null,
  terminal_reason: result.terminal_reason ?? null,
  is_error: result.is_error ?? null,
  result: typeof result.result === 'string' ? result.result.slice(0, 200) : null,
};

const report = { ran: true, cwd, interruptRequest: null };
try {
  child.stdin.write(promptLine('Write the integers from 1 to 2000, one per line, with no other text. Do not use any tools.'));
  report.streamedBeforeInterrupt = await until(
    () => values().some((value) => value?.type === 'stream_event' || value?.type === 'assistant'),
    120_000,
  );
  const init = values().find((value) => value?.type === 'system' && value?.subtype === 'init');
  report.cliVersion = init?.claude_code_version ?? null;
  report.capabilities = init?.capabilities ?? null;

  const interrupt = { type: 'control_request', request_id: 'probe-interrupt-1', request: { subtype: 'interrupt' } };
  report.interruptRequest = interrupt;
  const interruptedAt = Date.now();
  child.stdin.write(encodeLine(interrupt));
  // A message queued at the moment of the interrupt: does it run, merge, or vanish?
  child.stdin.write(promptLine('Reply with exactly: QUEUED-MESSAGE-RAN'));

  await until(() => values().some((value) => value?.type === 'control_response'), 30_000);
  report.controlResponse = values().find((value) => value?.type === 'control_response') ?? null;

  await until(() => results().length >= 1, 60_000);
  report.interruptedTurn = summary(results()[0]);
  report.msFromInterruptToResult = results()[0] === undefined
    ? null
    : frames.find((frame) => frame.value === results()[0]).at - interruptedAt;
  report.aliveAfterInterrupt = exited === null;

  // Give the queued message time to run if it is going to.
  await until(() => results().length >= 2, 60_000);
  const queuedResult = results().slice(1).find((result) => String(result.result ?? '').includes('QUEUED-MESSAGE-RAN'));
  report.queuedMessage = {
    resultsAfterInterrupt: results().slice(1).map(summary),
    ran: queuedResult !== undefined,
  };

  const before = results().length;
  child.stdin.write(promptLine('Reply with exactly: NEXT-PROMPT-RAN'));
  await until(() => results().length > before, 120_000);
  report.nextPrompt = summary(results()[before]);
  report.aliveAtEnd = exited === null;
} finally {
  child.stdin.end();
  await until(() => exited !== null, 30_000);
  if (exited === null) child.kill('SIGTERM');
  report.exit = exited;
  report.stderrTail = stderr.join('').slice(-2000);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
