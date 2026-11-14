// Deterministic process replay of the Claude Code 2.1.325 FOLD measurements (G-266, scripts/probe-claude-fold.mjs).
// No provider, credentials, filesystem tools or network is used.
//
// Measured: a prompt written while a turn runs is queued, then STARTED inside the running turn, and gets no result of
// its own. The running turn's result names both prompts in user_message_uuids. An interrupt while the folded prompt
// runs gets a receipt naming neither (cancelled: [], still_queued: []); the interrupted result lists both.
//
// Modes:
//   fold            the measured fold; every later prompt runs serially with its own result
//   serial          the second prompt is NOT folded: it waits, then runs with its own result
//   fold-cancel     the measured interrupt during a fold
//   fold-cancel-short  as fold-cancel, but the interrupted result omits the folded prompt
//   foreign         the result names a foreign id instead of the second prompt; the second then runs serially
//   malformed       the result's list omits the result's own prompt; the second then runs serially
import readline from 'node:readline';
const [mode] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lifecycle = (prompt, state) => ({ type: 'command_lifecycle', command_uuid: prompt.uuid, state, uuid: 'event-id', session_id: 'fixture' });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = (prompt, covered, aborted = false) => ({
  type: 'result', user_message_uuid: prompt.uuid, user_message_uuids: covered,
  subtype: aborted ? 'error_during_execution' : 'success', is_error: aborted,
  stop_reason: aborted ? 'tool_use' : 'end_turn', terminal_reason: aborted ? 'aborted_streaming' : 'completed',
  queued_turn_count: 0, result_index: 0, result: aborted ? undefined : prompt.text,
});
let active = null;
let folded = null;
let ran = 0;
const serial = (prompt) => {
  send(lifecycle(prompt, 'started')); send(delta('READY-' + prompt.text));
  send(result(prompt, [prompt.uuid])); send(lifecycle(prompt, 'completed'));
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'control_request' && value.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { models: [], claude_code_version: '2.1.325' } } });
    return;
  }
  if (value.type === 'control_request' && value.request?.subtype === 'interrupt') {
    if (active === null) return;
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { cancelled: [], still_queued: [] } } });
    if (folded !== null) send(lifecycle(folded, 'cancelled'));
    const covered = mode === 'fold-cancel-short' || folded === null ? [active.uuid] : [active.uuid, folded.uuid];
    send(result(active, covered, true)); send(lifecycle(active, 'cancelled'));
    active = null; folded = null;
    return;
  }
  if (value.type !== 'user') return;
  const prompt = { uuid: value.uuid, text: value.message.content.map(block => block.text ?? '').join('') };
  ran += 1;
  send(lifecycle(prompt, 'queued'));
  if (ran === 1) { active = prompt; send(lifecycle(prompt, 'started')); send(delta('READY-' + prompt.text)); return; }
  if (ran > 2 || active === null) { serial(prompt); return; }
  // The second prompt arrives while the first turn runs.
  const first = active;
  if (mode === 'serial') {
    setTimeout(() => { send(result(first, [first.uuid])); send(lifecycle(first, 'completed')); active = null; serial(prompt); }, 20);
    return;
  }
  send(lifecycle(prompt, 'started')); send(delta('READY-' + prompt.text));
  if (mode === 'fold-cancel' || mode === 'fold-cancel-short') { folded = prompt; return; }
  setTimeout(() => {
    const covered = mode === 'foreign' ? [first.uuid, 'foreign-prompt-id'] : mode === 'malformed' ? [prompt.uuid] : [first.uuid, prompt.uuid];
    send(result(first, covered));
    if (mode === 'fold') send(lifecycle(prompt, 'completed'));
    send(lifecycle(first, 'completed'));
    active = null;
    // Not folded after all (foreign, malformed): the second prompt still runs, with its own result.
    if (mode === 'foreign' || mode === 'malformed') setTimeout(() => { send(result(prompt, [prompt.uuid])); send(lifecycle(prompt, 'completed')); }, 20);
  }, 20);
});
