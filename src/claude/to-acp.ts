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
  META_RATE_LIMIT,
  META_THINKING_SIGNATURE,
  META_THINKING_TOKENS_ESTIMATE,
  META_UNMAPPED_FRAME,
  withMeta,
} from '../meta.js';

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
        title: name,
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

      case 'init':
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

  #resultFrame(input: Record<string, unknown>): AcpUpdate[] {
    const usage = isObject(input.usage) ? input.usage : {};
    const used = numberOf(usage.input_tokens) + numberOf(usage.output_tokens);
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

    const update: AcpUpdate = { sessionUpdate: 'usage_update', used, size };
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
    return [
      withMeta(
        {
          sessionUpdate: 'notice',
          notice: { level: 'warning', message: 'The provider reported a rate limit.' },
        },
        { [META_RATE_LIMIT]: input.rate_limit_info ?? input },
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
