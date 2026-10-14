/**
 * Translate the Claude CLI's `stream-json` output into ACP session updates.
 *
 * Every shape handled here was taken from CAPTURED TRAFFIC against
 * `claude --print --output-format stream-json --verbose
 * --include-partial-messages`, not from a schema reading. That distinction is
 * load-bearing in this package: the one handover we were offered turned out to
 * be a transcription plus a reading of an adapter's schema, never observed
 * bytes, so the mapping was written from a capture instead.
 *
 * One exception, said out loud: `background_tasks_changed` and `task_progress`
 * are mapped from the shapes DOCUMENTED in the Claude Agent SDK TypeScript
 * reference, because no capture contains them yet. The other three task frames
 * (`task_started`, `task_updated`, `task_notification`) are in the captured
 * subagent turn as well as the reference.
 *
 * The ACP field names and enum values come from the specification --
 * `sessionUpdate` discriminators, `tool_call` fields, the ten `kind` literals,
 * the four `status` literals. They are not inferred.
 *
 * ## Stateful on purpose
 *
 * `content_block_start` names a block and its index; the deltas that follow
 * reference only the index. A tool call's identity arrives in the start frame
 * and its arguments arrive across many `input_json_delta` frames. So a mapper
 * has to remember what each index is -- a stateless function would see
 * `{"index": 0, "delta": {...}}` and have no idea whether that is prose,
 * reasoning, or the arguments to a command about to run.
 */
import {
  META_BACKGROUND_TASKS,
  META_CLI_SESSION_ID,
  META_MODEL,
  META_PERMISSION_DENIED,
  META_RATE_LIMIT,
  META_TASK,
  META_THINKING_SIGNATURE,
  META_THINKING_TOKENS_ESTIMATE,
  META_UNMAPPED_FRAME,
  META_USAGE,
  withMeta,
} from '../meta.js';
import { stripAnsiControlSequences } from '../text.js';
import { rateLimitNotice, readRateLimit } from './rate-limit.js';

/** An ACP `session/update` payload: the `update` object, without the sessionId. */
export type AcpUpdate = Record<string, unknown> & { readonly sessionUpdate: string };

/** ACP's four tool-call states. */
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * ACP's ten tool kinds.
 *
 * Mapped from a tool NAME, which is a heuristic, so an unrecognised tool gets
 * NO kind rather than `other`. `kind` is optional in ACP, and the distinction
 * matters the same way `null` and `[]` differ: `other` asserts "this is none of
 * the ten", while omitting it says "we do not know which". Only one of those is
 * true for a custom MCP tool nobody here has seen.
 */
const TOOL_KINDS: Readonly<Record<string, string>> = {
  read: 'read',
  notebookread: 'read',
  write: 'edit',
  edit: 'edit',
  notebookedit: 'edit',
  multiedit: 'edit',
  bash: 'execute',
  bashoutput: 'execute',
  killshell: 'execute',
  glob: 'search',
  grep: 'search',
  webfetch: 'fetch',
  websearch: 'fetch',
  task: 'think',
  todowrite: 'other',
};

interface BlockState {
  readonly kind: 'text' | 'thinking' | 'tool_use';
  readonly toolCallId?: string;
  readonly name?: string;
  rawInputJson: string;
}

export class ClaudeToAcp {
  /** Live content blocks, keyed by the index the CLI assigns them. */
  readonly #blocks = new Map<number, BlockState>();

  /**
   * Frames this mapper did not recognise.
   *
   * Kept rather than counted. A mapper that only counted unknowns would tell
   * you something was missed without telling you what, and the first question
   * anyone asks is which.
   */
  readonly unmapped: unknown[] = [];

  /** Translate one CLI frame into zero or more ACP updates. */
  frame(input: unknown): AcpUpdate[] {
    if (!isObject(input)) return this.#unknown(input);

    switch (input.type) {
      case 'stream_event':
        return this.#streamEvent(input.event);
      case 'user':
        return this.#userFrame(input);
      case 'system':
        return this.#systemFrame(input);
      case 'result':
        return this.#resultFrame(input);
      case 'rate_limit_event':
        return this.#rateLimit(input);
      case 'assistant':
        // Deliberately ignored, and this is the one case where ignoring is
        // right: with --include-partial-messages the complete assistant message
        // is a REPLAY of deltas already emitted. Mapping both would duplicate
        // every word of every reply.
        return [];
      default:
        return this.#unknown(input);
    }
  }

  #streamEvent(event: unknown): AcpUpdate[] {
    if (!isObject(event)) return this.#unknown(event);

    switch (event.type) {
      case 'content_block_start':
        return this.#blockStart(event);
      case 'content_block_delta':
        return this.#blockDelta(event);
      case 'content_block_stop':
        return this.#blockStop(event);
      case 'message_start':
      case 'message_delta':
      case 'message_stop':
        // Envelope boundaries with no ACP counterpart and nothing a client
        // needs: the content they wrap is already mapped. Listed explicitly so
        // they are not silently absorbed by the default branch, which would
        // make the unmapped list noisy enough to stop being read.
        return [];
      default:
        return this.#unknown(event);
    }
  }

  #blockStart(event: Record<string, unknown>): AcpUpdate[] {
    const index = asIndex(event.index);
    const block = isObject(event.content_block) ? event.content_block : {};

    if (block.type === 'text') {
      this.#blocks.set(index, { kind: 'text', rawInputJson: '' });
      return [];
    }

    if (block.type === 'thinking') {
      this.#blocks.set(index, { kind: 'thinking', rawInputJson: '' });
      return [];
    }

    if (block.type === 'tool_use') {
      const toolCallId = asString(block.id) ?? `tool_${index}`;
      const name = asString(block.name) ?? 'unknown';
      this.#blocks.set(index, { kind: 'tool_use', toolCallId, name, rawInputJson: '' });

      const update: AcpUpdate = {
        sessionUpdate: 'tool_call',
        toolCallId,
        // `name` is the machine lookup key and stays verbatim; `title` is UI chrome.
        title: stripAnsiControlSequences(name).text,
        name,
        status: 'pending' satisfies ToolStatus,
      };
      const kind = TOOL_KINDS[name.toLowerCase()];
      // Omitted when unrecognised -- see TOOL_KINDS.
      return [kind === undefined ? update : { ...update, kind }];
    }

    return this.#unknown(event);
  }

  #blockDelta(event: Record<string, unknown>): AcpUpdate[] {
    const index = asIndex(event.index);
    const delta = isObject(event.delta) ? event.delta : {};
    const state = this.#blocks.get(index);

    switch (delta.type) {
      case 'text_delta':
        return [
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: asString(delta.text) ?? '' },
          },
        ];

      case 'thinking_delta': {
        // The estimate rides in _meta, never in usage_update: it is an
        // estimate, and usage_update reports measurement. See src/meta.ts.
        const chunk: AcpUpdate = {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: asString(delta.thinking) ?? '' },
        };
        const estimate = delta.estimated_tokens;
        return [
          typeof estimate === 'number'
            ? withMeta(chunk, { [META_THINKING_TOKENS_ESTIMATE]: estimate })
            : chunk,
        ];
      }

      case 'signature_delta':
        // PRESERVED. This is the integrity signature on a thinking block, and
        // an exhaustive switch with no case for it would look complete while
        // quietly making every thinking block unverifiable.
        return [
          withMeta(
            { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } },
            { [META_THINKING_SIGNATURE]: asString(delta.signature) ?? '' },
          ),
        ];

      case 'input_json_delta': {
        // Accumulated, not emitted per fragment: a partial JSON string is not
        // parseable and a client shown half an argument list would render
        // something misleading about what is going to run.
        if (state?.kind === 'tool_use') {
          state.rawInputJson += asString(delta.partial_json) ?? '';
        }
        return [];
      }

      default:
        return this.#unknown(event);
    }
  }

  #blockStop(event: Record<string, unknown>): AcpUpdate[] {
    const index = asIndex(event.index);
    const state = this.#blocks.get(index);
    this.#blocks.delete(index);

    if (state?.kind !== 'tool_use' || state.toolCallId === undefined) return [];

    const update: AcpUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: state.toolCallId,
      status: 'in_progress' satisfies ToolStatus,
    };

    // rawInput is a real ACP field, so the arguments go there rather than into
    // _meta. Only when they parse: handing a client a half-written string under
    // a field named rawInput would be worse than omitting it.
    const parsed = tryParse(state.rawInputJson);
    return [parsed === undefined ? update : { ...update, rawInput: parsed }];
  }

  #userFrame(input: Record<string, unknown>): AcpUpdate[] {
    const message = isObject(input.message) ? input.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const updates: AcpUpdate[] = [];

    for (const entry of content) {
      if (!isObject(entry) || entry.type !== 'tool_result') continue;
      const toolCallId = asString(entry.tool_use_id);
      if (toolCallId === undefined) continue;

      // `is_error` decides between two of ACP's four statuses. Defaulting a
      // failed call to `completed` would report a failure as a success, which
      // is the direction that misleads.
      const failed = entry.is_error === true;
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: (failed ? 'failed' : 'completed') satisfies ToolStatus,
        content: [{ type: 'content', content: { type: 'text', text: textOf(entry.content) } }],
      });
    }

    return updates.length > 0 ? updates : this.#unknown(input);
  }

  #systemFrame(input: Record<string, unknown>): AcpUpdate[] {
    switch (input.subtype) {
      case 'commands_changed':
        // Reported even when empty: `[]` says the agent offers none, which is a
        // claim worth making. Reporting nothing would leave a client unable to
        // tell "offers none" from "we never asked".
        return [
          {
            sessionUpdate: 'available_commands_update',
            availableCommands: Array.isArray(input.commands) ? input.commands : [],
          },
        ];

      case 'thinking_tokens':
        return [
          withMeta(
            { sessionUpdate: 'notice', notice: { level: 'debug', message: 'thinking' } },
            { [META_THINKING_TOKENS_ESTIMATE]: input.estimated_tokens ?? null },
          ),
        ];

      case 'permission_denied': {
        // This payload shape was captured from Claude Code 2.1.295; the ids in
        // the checked-in projection are redacted, and the rejection text is UI input.
        const toolCallId = asString(input.tool_use_id);
        if (toolCallId === undefined) return this.#unknown(input);

        // `failed` is ACP's nearest honest status; it cannot distinguish a
        // refusal from a crash, so the metadata below carries that distinction.
        // Emit even without a prior tool_call: a missing opener must not hide
        // the denial, and the provider id is the only correlation we have.
        const details: Record<string, unknown> = {};
        let providerTextSanitized = false;
        for (const field of [
          'tool_name',
          'decision_reason_type',
          'decision_reason_code',
          'decision_reason',
        ]) {
          const value = asString(input[field]);
          if (value !== undefined) {
            const sanitized = stripAnsiControlSequences(value);
            details[field] = sanitized.text;
            providerTextSanitized ||= sanitized.changed;
          }
        }

        const message = asString(input.message);
        const content = message === undefined ? undefined : stripAnsiControlSequences(message);
        if (content?.changed) providerTextSanitized = true;
        // Preserve the fact of sanitization without echoing removed provider bytes.
        if (providerTextSanitized) details.providerTextSanitized = true;

        const update: AcpUpdate = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed' satisfies ToolStatus,
          ...(content === undefined
            ? {}
            : {
                content: [
                  {
                    type: 'content' as const,
                    content: { type: 'text' as const, text: content.text },
                  },
                ],
              }),
        };

        return [withMeta(update, { [META_PERMISSION_DENIED]: details })];
      }

      case 'init': {
        // The init frame carries the CLI's OWN session id, and that is the only
        // string `--resume` accepts -- so it is the only string `session/load`
        // can work with. It used to be recorded as unmapped, which meant the
        // driver captured it, kept it correctly separate from ACP's sessionId,
        // and then nothing handed it to the client. Resume was a method the
        // client could not supply an argument for.
        //
        // Emitted on the FIRST frame of a session rather than at the end of a
        // turn: a session that fails early still needs to be resumable, and a
        // client cannot store what it was never sent.
        const cliSessionId = asString(input.session_id);
        if (cliSessionId === undefined) return this.#unknown(input);

        // The model in use, when the CLI names it (measured: `--model haiku` -> `model: 'claude-haiku-5-5'`).
        const model = asString(input.model);
        return [
          withMeta(
            { sessionUpdate: 'notice', notice: { level: 'debug', message: 'session started' } },
            { [META_CLI_SESSION_ID]: cliSessionId, ...(model === undefined || model.length === 0 ? {} : { [META_MODEL]: model }) },
          ),
        ];
      }

      case 'background_tasks_changed':
        return this.#backgroundTasks(input);

      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        return this.#task(input, input.subtype);

      case 'status':
      case 'api_retry':
        // Not mapped, but RECORDED. api_retry especially: it is how an
        // outranked credential announces itself (401, ten times), and a mapper
        // that dropped it would hide the single most expensive failure this
        // package exists to prevent.
        return this.#unknown(input);

      default:
        return this.#unknown(input);
    }
  }

  /**
   * The full live set of background tasks (Claude Code >= 2.1.203).
   *
   * Shapes from the Claude Agent SDK reference (SDKBackgroundTasksChangedMessage).
   * Before this case the frame fell to `#unknown`, so a client could see none
   * of the shells, Monitor watches and subagents an agent had running.
   *
   * An empty array is emitted: "nothing is running" is a claim, and a client
   * that replaces its cached set with each payload needs it to clear.
   */
  #backgroundTasks(input: Record<string, unknown>): AcpUpdate[] {
    if (!Array.isArray(input.tasks)) return this.#unknown(input);

    const tasks: Record<string, unknown>[] = [];
    let malformed = false;
    for (const entry of input.tasks) {
      const taskId = isObject(entry) ? nonEmptyString(entry.task_id) : undefined;
      if (!isObject(entry) || taskId === undefined) {
        malformed = true;
        continue;
      }
      tasks.push({ taskId, ...copyFields(entry, BACKGROUND_TASK_FIELDS) });
    }
    // A bad entry must not withhold the rest of the set (that would read as
    // "nothing running"), and must not vanish either: the frame is recorded.
    if (malformed) this.unmapped.push(input);

    return [
      withMeta(
        { sessionUpdate: 'notice', notice: { level: 'debug', message: 'background tasks' } },
        { [META_BACKGROUND_TASKS]: tasks },
      ),
    ];
  }

  /**
   * One task's lifecycle event: task_started / task_progress / task_updated /
   * task_notification. Shapes from the Claude Agent SDK reference; the
   * started/updated/notification trio is also in the captured subagent turn.
   *
   * ACP's `subagent_update` has no published payload shape, so these ride as
   * debug notices with the detail under META_TASK rather than inventing one.
   */
  #task(input: Record<string, unknown>, subtype: keyof typeof TASK_EVENTS): AcpUpdate[] {
    const taskId = nonEmptyString(input.task_id);
    if (taskId === undefined) return this.#unknown(input);

    const { event, message } = TASK_EVENTS[subtype];
    const task: Record<string, unknown> = { event, taskId, ...copyFields(input, TASK_FIELDS) };
    let sanitized = task.providerTextSanitized === true;

    if (isObject(input.patch)) {
      const patch = copyFields(input.patch, TASK_PATCH_FIELDS);
      if (patch.providerTextSanitized === true) {
        delete patch.providerTextSanitized;
        sanitized = true;
      }
      task.patch = patch;
    }
    if (isObject(input.usage)) task.usage = copyFields(input.usage, TASK_USAGE_FIELDS);

    // Preserve the fact of sanitization without echoing removed provider bytes.
    if (sanitized) task.providerTextSanitized = true;

    return [
      withMeta(
        { sessionUpdate: 'notice', notice: { level: 'debug', message } },
        { [META_TASK]: task },
      ),
    ];
  }

  #resultFrame(input: Record<string, unknown>): AcpUpdate[] {
    const usage = isObject(input.usage) ? input.usage : {};
    // ALL the input the context holds -- fresh, read from cache, written to cache -- plus the output. `input_tokens`
    // alone excludes the cached input: measured, a one-word turn reported 2 in / 4 out with 18,999 read from cache and
    // 16,522 written, so the old sum said 6 for a context of ~35.5k (issue #3).
    const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : null;
    const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : null;
    const used = numberOf(usage.input_tokens) + (cacheRead ?? 0) + (cacheCreation ?? 0) + numberOf(usage.output_tokens);
    const split = {
      scope: 'turn' as const,
      inputTokens: numberOf(usage.input_tokens),
      outputTokens: numberOf(usage.output_tokens),
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
    };
    const size = contextWindowOf(input.modelUsage);

    // ACP requires BOTH `used` and `size` on usage_update. Without a context
    // window there is no honest update to send, so none is sent and the figures
    // ride in _meta instead -- a required field is not somewhere to put a guess.
    if (size === undefined) {
      return [
        withMeta({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'turn complete' } }, {
          [META_UNMAPPED_FRAME]: { reason: 'usage_update needs a context size', usage },
        }),
      ];
    }

    const update: AcpUpdate = withMeta({ sessionUpdate: 'usage_update', used, size }, { [META_USAGE]: split });
    const cost = input.total_cost_usd;
    return [
      typeof cost === 'number'
        ? { ...update, cost: { amount: cost, currency: 'USD' } }
        : update,
    ];
  }

  #rateLimit(input: Record<string, unknown>): AcpUpdate[] {
    // A notice because it is genuinely user-facing, AND _meta so a client can
    // act on the reset times rather than parse a sentence.
    //
    // The payload is NARROWED rather than passed through. A rename by the
    // provider used to reach the consumer as a field it could not read, which
    // a gauge renders as empty -- and an empty headroom gauge reads as plenty
    // of headroom. So an unrecognised payload now emits no rate-limit value at
    // all and keeps the frame under `unmapped_frame` instead: absent and
    // explained, rather than zero and plausible.
    //
    // The refusal NAMES THE FIELD, because the refusal is total: one bad field
    // rejects the whole payload, so this reason is the only thing a human gets.
    // A generic "not recognised" would turn a bug report from "they renamed
    // utilization" into "the gauge vanished", and someone diffing a frame by
    // hand to tell the difference.
    const read = readRateLimit(input.rate_limit_info ?? input);

    if (!read.ok) {
      return [
        withMeta(
          {
            sessionUpdate: 'notice',
            notice: { level: 'warning', message: 'The provider reported a rate limit.' },
          },
          {
            [META_UNMAPPED_FRAME]: { reason: read.reason, frame: input },
          },
        ),
      ];
    }

    return [
      withMeta(
        {
          sessionUpdate: 'notice',
          notice: { level: 'warning', message: rateLimitNotice(read.limit) },
        },
        { [META_RATE_LIMIT]: read.limit },
      ),
    ];
  }

  /**
   * Record a frame with no mapping and emit nothing.
   *
   * Nothing is dropped silently -- `unmapped` keeps the frame itself, so the
   * question "what did we not handle" has an answer rather than a count. This
   * is the opposite of a `default:` that absorbs the unknown, which makes a
   * surface quietly stop showing something nobody remembers it had.
   */
  #unknown(frame: unknown): AcpUpdate[] {
    this.unmapped.push(frame);
    return [];
  }
}

/**
 * How a provider field becomes a client field: its camelCase name and its type.
 * `text` is a string a person reads, so it is sanitized; `string` is an id or
 * enum and stays verbatim, as a tool's machine `name` does.
 */
type FieldSpec = readonly [from: string, to: string, type: 'string' | 'text' | 'number' | 'boolean'];

const BACKGROUND_TASK_FIELDS: readonly FieldSpec[] = [
  ['run_id', 'runId', 'string'],
  ['task_type', 'taskType', 'string'],
  ['subagent_type', 'subagentType', 'string'],
  ['description', 'description', 'text'],
  ['parent_task_id', 'parentTaskId', 'string'],
  ['ambient', 'ambient', 'boolean'],
];

const TASK_FIELDS: readonly FieldSpec[] = [
  ['run_id', 'runId', 'string'],
  ['tool_use_id', 'toolUseId', 'string'],
  ['description', 'description', 'text'],
  ['task_type', 'taskType', 'string'],
  ['subagent_type', 'subagentType', 'string'],
  ['is_backgrounded', 'isBackgrounded', 'boolean'],
  ['spawn_depth', 'spawnDepth', 'number'],
  ['parent_task_id', 'parentTaskId', 'string'],
  ['ambient', 'ambient', 'boolean'],
  ['status', 'status', 'string'],
  ['reason', 'reason', 'string'],
  ['output_file', 'outputFile', 'string'],
  ['summary', 'summary', 'text'],
  ['last_tool_name', 'lastToolName', 'string'],
];

const TASK_PATCH_FIELDS: readonly FieldSpec[] = [
  ['status', 'status', 'string'],
  ['description', 'description', 'text'],
  ['end_time', 'endTime', 'number'],
  ['total_paused_ms', 'totalPausedMs', 'number'],
  ['error', 'error', 'text'],
  ['is_backgrounded', 'isBackgrounded', 'boolean'],
];

const TASK_USAGE_FIELDS: readonly FieldSpec[] = [
  ['total_tokens', 'totalTokens', 'number'],
  ['tool_uses', 'toolUses', 'number'],
  ['duration_ms', 'durationMs', 'number'],
];

const TASK_EVENTS = {
  task_started: { event: 'started', message: 'task started' },
  task_progress: { event: 'progress', message: 'task progress' },
  task_updated: { event: 'updated', message: 'task updated' },
  task_notification: { event: 'ended', message: 'task ended' },
} as const;

/**
 * Copy the fields that are present AND of the documented type. A field of the
 * wrong type is left out rather than coerced. Sets `providerTextSanitized` when
 * any `text` field had control sequences removed.
 */
function copyFields(source: Record<string, unknown>, specs: readonly FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let sanitized = false;
  for (const [from, to, type] of specs) {
    const value = source[from];
    if (type === 'text') {
      if (typeof value !== 'string') continue;
      const clean = stripAnsiControlSequences(value);
      out[to] = clean.text;
      sanitized ||= clean.changed;
    } else if (typeof value === type) {
      out[to] = value;
    }
  }
  if (sanitized) out.providerTextSanitized = true;
  return out;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asIndex(value: unknown): number {
  return typeof value === 'number' ? value : -1;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function tryParse(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The context window of whichever model the turn reported usage for. */
function contextWindowOf(modelUsage: unknown): number | undefined {
  if (!isObject(modelUsage)) return undefined;
  for (const entry of Object.values(modelUsage)) {
    if (isObject(entry) && typeof entry.contextWindow === 'number') return entry.contextWindow;
  }
  return undefined;
}

/** Flatten a tool result's content, which is a string or an array of blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => (isObject(entry) && typeof entry.text === 'string' ? entry.text : ''))
    .join('');
}
