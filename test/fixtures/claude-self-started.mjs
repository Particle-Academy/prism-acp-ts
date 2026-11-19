// Deterministic process replay of a turn the Claude CLI starts ON ITS OWN (G-313, measured by tynn on Tynn #855): a
// background task the agent started finishes after the previous turn settled, and the CLI runs a turn for it -- live
// output, then a result naming none of the client's prompts. No provider, credentials, filesystem tools or network.
//
// Prompt text drives what follows the prompt's own (serial) turn:
//   BG          one self-started turn, with usage, after this prompt's result
//   BG2         two self-started turns in a row
//   BG-HOLD     a self-started turn that STARTS and keeps running; the next prompt written decides how it ends:
//                 mode 'fold'  the prompt is folded into it and named in its user_message_uuids
//                 mode 'queue' the prompt waits; the self-started turn ends alone, then the prompt runs serially
//   STRAY       a lone result naming no prompt of ours, with no live output before it
//   anything else  a plain serial turn
// With --resume, the CLI first replays an earlier turn: frames marked isReplay, then that turn's result.
import readline from 'node:readline';
const mode = process.argv[2];
const resumed = process.argv.includes('--resume');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lifecycle = (uuid, state) => ({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: 'event-id', session_id: 'fixture' });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
const assistant = (id, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], usage }, ...extra });
const result = (uuid, covered, extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed',
  ...(uuid === undefined ? {} : { user_message_uuid: uuid }), user_message_uuids: covered,
  usage, modelUsage: { 'claude-fixture': { contextWindow: 200000 } }, total_cost_usd: 0.01, result: 'done', ...extra,
});
let selfCount = 0;
let held = null;
const selfTurn = () => {
  const own = 'cli-task-notification-' + (++selfCount);
  send(delta('SELF-' + selfCount)); send(assistant('msg-self-' + selfCount));
  send(result(own, [own]));
};
const serial = prompt => {
  send(lifecycle(prompt.uuid, 'queued')); send(lifecycle(prompt.uuid, 'started'));
  send(delta('READY-' + prompt.text)); send(assistant('msg-' + prompt.uuid));
  send(result(prompt.uuid, [prompt.uuid])); send(lifecycle(prompt.uuid, 'completed'));
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'control_request' && value.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { models: [], claude_code_version: '2.1.325' } } });
    if (resumed) {
      send({ type: 'user', isReplay: true, uuid: 'old-prompt', message: { role: 'user', content: [{ type: 'text', text: 'OLD' }] } });
      send(assistant('msg-old', { isReplay: true }));
      send(result('old-prompt', ['old-prompt']));
      send(result(undefined, undefined));
    }
    return;
  }
  if (value.type !== 'user') return;
  const prompt = { uuid: value.uuid, text: value.message.content.map(block => block.text ?? '').join('') };
  if (held !== null) {
    // A self-started turn is running.
    held = null;
    send(lifecycle(prompt.uuid, 'queued'));
    if (mode === 'fold') {
      send(lifecycle(prompt.uuid, 'started')); send(delta('READY-' + prompt.text));
      setTimeout(() => {
        const own = 'cli-task-notification-' + selfCount;
        send(result(own, [own, prompt.uuid])); send(lifecycle(prompt.uuid, 'completed'));
      }, 20);
    } else {
      setTimeout(() => {
        const own = 'cli-task-notification-' + selfCount;
        send(result(own, [own]));
        send(lifecycle(prompt.uuid, 'started')); send(delta('READY-' + prompt.text)); send(assistant('msg-' + prompt.uuid));
        send(result(prompt.uuid, [prompt.uuid])); send(lifecycle(prompt.uuid, 'completed'));
      }, 20);
    }
    return;
  }
  serial(prompt);
  if (prompt.text === 'BG') setTimeout(() => selfTurn(), 20);
  if (prompt.text === 'BG2') setTimeout(() => { selfTurn(); setTimeout(() => selfTurn(), 20); }, 20);
  if (prompt.text === 'STRAY') setTimeout(() => send(result('cli-stray', ['cli-stray'])), 20);
  if (prompt.text === 'BG-HOLD') {
    setTimeout(() => { selfCount += 1; held = selfCount; send(delta('SELF-' + selfCount)); send(assistant('msg-self-' + selfCount)); }, 20);
  }
});
