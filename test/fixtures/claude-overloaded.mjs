// A Claude CLI stand-in that replays what Claude Code 2.1.332 did when its model answered HTTP 529 (measured
// 2026-11-25 against a loopback model with a synthetic key; no account, no paid request). No provider, credentials,
// filesystem tools or network.
//
// What the measured CLI did, and this replays:
//   - it retried the 529 itself, announcing each attempt as `system/api_retry` with ITS OWN wait (`retry_delay_ms`:
//     3037 and 3080 for a stated `retry-after: 3`, 567 and 1217 for none), and never forwarded the header;
//   - with a long `retry-after` (900 s) it did not retry at all, and said nothing about the header either;
//   - it then ended the turn with an assistant `error: "server_error"` carrying `api_error_status: 529` and
//     `api_error_type: "overloaded_error"`, and a result with `is_error: true`, `terminal_reason: "api_error"`;
//   - the process stayed, and the next prompt in the same session ran to `end_turn`.
//
// The prompt text picks the turn:
//   OVERLOADED-RETRIED   two api_retry frames (a stated retry-after), then the 529 failure
//   OVERLOADED-NO-RETRY  the 529 failure with no api_retry before it (no retry-after, or one too long to wait)
//   OVERLOADED-MID-TURN  a tool call and its result, then the 529 failure on the next model request
//   RATE-LIMITED         the measured 429: api_retry, then `error: "rate_limit"` / `api_error_status: 429`
//   OVERLOADED-EXIT      the 529 failure, then the process exits
//   anything else        a clean turn whose text names how many prompts this ONE process has received
// Every user line read is reported on stderr as `RECV user:<text>`.
import readline from 'node:readline';

const SESSION = '0c5e7f2a-6b1d-4e8a-9c3f-2a7b5d8e1f40';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const API_ERROR_TEXT = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.';
let prompts = 0;
let initialized = false;

const apiRetry = (attempt, delay, status = 529, error = 'overloaded') => ({
  type: 'system', subtype: 'api_retry', attempt, max_retries: 2, retry_delay_ms: delay, error_status: status, error,
  session_id: SESSION, uuid: `retry-${attempt}`,
});
const apiError = (error, status, type, text) => ({
  type: 'assistant', parent_tool_use_id: null, session_id: SESSION, uuid: `api-error-${prompts}`,
  message: { id: `synthetic-${prompts}`, model: '<synthetic>', role: 'assistant', type: 'message', stop_reason: 'stop_sequence',
    content: [{ type: 'text', text }], usage },
  error, request_id: 'req_synthetic', is_api_error_message: true, api_error_status: status, api_error_type: type,
});
const failedResult = (uuid, status, type, text) => ({
  type: 'result', subtype: 'success', is_error: true, stop_reason: 'stop_sequence', terminal_reason: 'api_error',
  api_error_status: status, api_error_type: type, result: text, session_id: SESSION, num_turns: 1,
  user_message_uuid: uuid, user_message_uuids: [uuid], usage,
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'control_request' && value.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { models: [], claude_code_version: '2.1.332' } } });
    return;
  }
  if (value.type !== 'user') return;
  const text = value.message.content.map((block) => block.text ?? '').join('');
  process.stderr.write(`RECV user:${text}\n`);
  prompts += 1;
  const uuid = value.uuid;
  if (!initialized) {
    initialized = true;
    send({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [] });
  }
  if (text.startsWith('OVERLOADED') ) {
    if (text === 'OVERLOADED-RETRIED') { send(apiRetry(1, 3037)); send(apiRetry(2, 3080)); }
    if (text === 'OVERLOADED-MID-TURN') {
      send({ type: 'assistant', parent_tool_use_id: null, session_id: SESSION, uuid: 'tool-call',
        message: { id: 'msg_tool', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_measure', name: 'Read', input: { file_path: 'note.txt' } }], usage } });
      send({ type: 'user', parent_tool_use_id: null, session_id: SESSION, uuid: 'tool-result',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_measure', content: 'NOTE-CONTENT' }] } });
      send(apiRetry(1, 3530));
    }
    send(apiError('server_error', 529, 'overloaded_error', API_ERROR_TEXT));
    send(failedResult(uuid, 529, 'overloaded_error', API_ERROR_TEXT));
    if (text === 'OVERLOADED-EXIT') setTimeout(() => process.exit(1), 20);
    return;
  }
  if (text === 'RATE-LIMITED') {
    const limited = 'API Error: Request rejected (429) · Rate limited';
    send(apiRetry(1, 5968, 429, 'rate_limit'));
    send(apiError('rate_limit', 429, 'rate_limit_error', limited));
    send(failedResult(uuid, 429, 'rate_limit_error', limited));
    return;
  }
  send({ type: 'assistant', parent_tool_use_id: null, session_id: SESSION, uuid: `answer-${prompts}`,
    message: { id: `msg_${prompts}`, role: 'assistant', content: [{ type: 'text', text: `PROMPTS-SEEN-${prompts}` }], usage } });
  send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed',
    result: `PROMPTS-SEEN-${prompts}`, session_id: SESSION, user_message_uuid: uuid, user_message_uuids: [uuid], usage });
});
