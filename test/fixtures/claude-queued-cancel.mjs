// Deterministic process replay of the CLI 2.1.318 UUID/interrupt measurements.
// No provider, credentials, filesystem tools or network is used.
import fs from 'node:fs';
import readline from 'node:readline';
const [mode, journal] = process.argv.slice(2);
const state = { users: [], interrupts: [], initialized: false };
// Readers only open immutable, completely published snapshots. Replacing an open
// journal is an unnecessary Windows sharing/permission dependency in a protocol test.
fs.mkdirSync(journal + '.snapshots');
let sequence = 0;
const save = () => {
  const target = journal + '.snapshots/' + String(++sequence).padStart(6, '0') + '.json';
  fs.writeFileSync(target + '.tmp', JSON.stringify(state), { flag: 'wx' });
  fs.renameSync(target + '.tmp', target);
};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lifecycle = (prompt, value) => ({ type: 'command_lifecycle', command_uuid: prompt.uuid, state: value, uuid: 'event-is-not-the-command-id', detail: 'PRIVATE-LIFECYCLE-CONTENT' });
const result = (prompt, aborted = false) => ({ type: 'result', user_message_uuid: prompt.uuid, subtype: aborted ? 'error_during_execution' : 'success', is_error: aborted, stop_reason: aborted ? null : 'end_turn', terminal_reason: aborted ? 'aborted_streaming' : 'completed', result: aborted ? undefined : prompt.text });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
let pending = [], post = null, interrupted = false, late = null;
save();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'control_request' && value.request?.subtype === 'initialize') {
    state.initialized = true; save();
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { models: [], claude_code_version: '2.1.318' } } });
    return;
  }
  if (value.type === 'user') {
    const prompt = { uuid: value.uuid, text: value.message.content.map(block => block.text ?? '').join('') };
    state.users.push(prompt); save();
    if (mode === 'exit' && prompt.text === 'SECOND') process.exit(23);
    if (prompt.text === 'NEXT' || prompt.text.startsWith('FINISH')) {
      if (late) { send(result(late, true)); late = null; }
      send(lifecycle(prompt, 'queued')); send(lifecycle(prompt, 'started'));
      send(mode === 'legacy-serial' ? { ...result(prompt), user_message_uuid: undefined } : result(prompt));
      send(lifecycle(prompt, 'completed'));
      return;
    }
    if (interrupted && ['post', 'post-queued', 'post-drop', 'malformed-post'].includes(mode)) { post = prompt; return; }
    pending.push(prompt);
    send(lifecycle(prompt, 'queued'));
    if ((pending.length === 1 || mode === 'active') && mode !== 'corroboration') send(lifecycle(prompt, 'started'));
    if (mode === 'lifecycle-only' || mode === 'corroboration') send(lifecycle(prompt, 'cancelled'));
    if (mode === 'foreign-result') send({ ...result(prompt), user_message_uuid: 'foreign-result-id' });
    if (mode === 'unasked-abort') { send(result(prompt, true)); pending = []; }
    send(delta('READY-' + prompt.text));
    return;
  }
  if (value.type !== 'control_request' || value.request?.subtype !== 'interrupt') return;
  state.interrupts.push(value); save();
  if (pending.length === 0) return;
  interrupted = true;
  const current = pending.splice(0);
  if (mode === 'no-receipt') { late = current[0]; return; }
  let body = { cancelled: current.slice(1).map(prompt => prompt.uuid).filter(Boolean), still_queued: [] };
  if (mode === 'active') body.cancelled = [];
  if (mode === 'foreign-receipt') body.cancelled = ['foreign-prompt-id'];
  if (mode === 'under-count') body.cancelled = [];
  if (mode === 'still-queued') { body.cancelled = []; body.still_queued = current.slice(1).map(prompt => prompt.uuid).filter(Boolean); }
  if (mode === 'malformed' || mode === 'malformed-post') body = { cancelled: 'PRIVATE-RECEIPT-CONTENT', still_queued: [] };
  if (mode === 'missing') body = {};
  if (mode === 'overlap') body.still_queued = [...body.cancelled];
  if (mode === 'duplicate-id') body.cancelled = [...body.cancelled, ...body.cancelled];
  const response = { type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: body } };
  if (mode === 'post-queued') {
    setTimeout(() => {
      if (post?.uuid) body.still_queued.push(post.uuid);
      for (const prompt of current.slice(1)) send(lifecycle(prompt, 'cancelled'));
      send(response); send(result(current[0], true)); if (post) send(result(post)); post = null;
    }, 25);
    return;
  }
  if (mode === 'post-drop') {
    setTimeout(() => {
      if (post?.uuid) body.cancelled.push(post.uuid);
      for (const prompt of [...current.slice(1), ...(post ? [post] : [])]) send(lifecycle(prompt, 'cancelled'));
      send(response); send(result(current[0], true)); post = null;
    }, 25);
    return;
  }
  if (mode === 'active') {
    // First result in transit when the second prompt has already become active.
    process.stdout.write([result(current[0]), response, result(current[1], true), lifecycle(current[1], 'cancelled')].map(v => JSON.stringify(v) + '\n').join(''));
    return;
  }
  if (!['still-queued', 'under-count'].includes(mode)) for (const prompt of current.slice(1)) send(lifecycle(prompt, 'cancelled'));
  send(response);
  if (mode === 'permission-fail') { send({ type: 'system', subtype: 'init', claude_code_version: '2.1.999' }); return; }
  if (mode === 'corroboration') return;
  if (['foreign-receipt', 'under-count', 'still-queued', 'malformed', 'malformed-post', 'missing', 'overlap', 'duplicate-id'].includes(mode)) { late = current[0]; return; }
  if (mode === 'post') {
    // The third prompt is received before the active native result, but runs after it.
    setTimeout(() => { send(result(current[0], true)); send(lifecycle(current[0], 'cancelled')); if (post) { send(result(post)); post = null; } }, 25);
  } else {
    send(result(current[0], true));
    send(lifecycle(current[0], 'cancelled'));
    // A replayed receipt/lifecycle is corroboration, never another completion.
    send(response);
    for (const prompt of current.slice(1)) send(lifecycle(prompt, 'cancelled'));
  }
});
