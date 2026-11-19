// A Claude CLI stand-in for liveness (G-314). No provider, credentials, filesystem tools or network.
//
// Mode (argv[2]) decides how it treats the driver's `mcp_status` control request:
//   answer    answers it, by its request_id
//   error     answers it with a control error, by its request_id (an older CLI that does not know the subtype)
//   hung      reads it and never answers (a stalled provider)
//   mismatch  answers it only under OTHER ids: a different request_id, then none at all
//   silent    answers nothing, not even initialize
// Every line read is reported on stderr as `RECV <type>:<subtype or text>`, so a test can count what was written.
//
// A prompt `SLOW` is a turn that streams one delta, then holds for 300 ms before its message, usage and result: a
// window in which a test can ping mid-turn. Its ids are fixed, so two runs of it produce the same frames.
import readline from 'node:readline';
const mode = process.argv[2] ?? 'answer';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lifecycle = (uuid, state) => ({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: 'event-id', session_id: 'fixture' });
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  const text = value.type === 'user' ? value.message.content.map(block => block.text ?? '').join('') : value.request?.subtype;
  process.stderr.write(`RECV ${value.type}:${text}\n`);
  if (mode === 'silent') return;
  if (value.type === 'control_request' && value.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { models: [], claude_code_version: '2.1.327' } } });
    return;
  }
  if (value.type === 'control_request' && value.request?.subtype === 'mcp_status') {
    if (mode === 'answer') send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { mcpServers: [] } } });
    if (mode === 'error') send({ type: 'control_response', response: { subtype: 'error', request_id: value.request_id, error: 'Unsupported control request subtype: mcp_status' } });
    if (mode === 'mismatch') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: `${value.request_id}-other`, response: { mcpServers: [] } } });
      send({ type: 'control_response', response: { subtype: 'success', response: { mcpServers: [] } } });
    }
    return;
  }
  if (value.type !== 'user') return;
  const uuid = value.uuid;
  send(lifecycle(uuid, 'queued')); send(lifecycle(uuid, 'started'));
  send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FIRST-' + text } } });
  setTimeout(() => {
    send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg-fixed', role: 'assistant', content: [{ type: 'text', text: 'done-' + text }], usage } });
    send({
      type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed',
      user_message_uuid: uuid, user_message_uuids: [uuid],
      usage, modelUsage: { 'claude-fixture': { contextWindow: 200000 } }, total_cost_usd: 0.01, result: 'done',
    });
    send(lifecycle(uuid, 'completed'));
  }, text === 'SLOW' ? 300 : 0);
});
