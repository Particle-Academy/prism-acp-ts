import { randomBytes } from 'node:crypto';
import { childEnv } from './env.js';
import { assertModel } from './meta.js';
import { NdjsonFramer, encodeLine } from './ndjson.js';
import { launchProvider } from './process-tree.js';
import { stripAnsiControlSequences } from './text.js';

/**
 * THE MODELS A PROVIDER ACTUALLY OFFERS (tynn, Genie's model picker, 2026-10-21). Genie's picker was a hardcoded
 * `['sonnet', 'opus', 'haiku']`, so a model the signed-in account has -- Fable -- never appeared. The list comes from
 * the provider now, for the account that is signed in:
 *
 *  - Claude: the control `initialize` request. Its response carries `models` (`value`, `resolvedModel`, `displayName`,
 *    `description`), which is what the Agent SDK's documented `Query.supportedModels()` returns. The request body,
 *    `{ subtype: 'initialize' }`, is MEASURED, not documented: scripts/probe-claude-models.mjs, claude-code 2.1.301,
 *    2026-10-21 -- answered in about a second, before any prompt, listing 13 models including Fable.
 *  - Codex: the app-server's `model/list` (its own schema: ModelListParams -> ModelListResponse { data, nextCursor }),
 *    paged. Measured with scripts/probe-codex-models.mjs, codex-cli 0.163.0.
 *
 * The shape is ACP's (unstable) session model state, so a client can show it as it is: `availableModels` with
 * `modelId`, `name` and `description`, and `currentModelId`.
 */

/** One model a provider offers. `modelId` is what to pass back to select it. */
export interface AvailableModel {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string;
  /** The concrete model an alias resolves to (Claude: `opus` -> `claude-opus-5-5`), when the provider says. */
  readonly resolvedModel?: string;
  /** The provider's own default, when it marks one. */
  readonly isDefault?: boolean;
}

/** ACP's session model state. `currentModelId` is null when nothing says which model is selected. */
export interface SessionModelState {
  readonly availableModels: readonly AvailableModel[];
  readonly currentModelId: string | null;
}

/** Thrown when a provider will not say which models it offers. The message names no path. */
export class ModelListError extends Error {
  override readonly name = 'ModelListError';
}

const MAX_MODELS = 500;
const MAX_TEXT = 500;

/** Provider text is shown to a person: terminal control sequences are removed and length is bounded. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = stripAnsiControlSequences(value).text.trim();
  return clean.length === 0 ? undefined : clean.slice(0, MAX_TEXT);
}

/** A model id is also an argument the provider will be handed back: it must pass the same check a `model` option does. */
function modelId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200) return undefined;
  try {
    return assertModel(value);
  } catch {
    return undefined;
  }
}

/** The models in Claude's `initialize` response. Entries without a usable id are left out, not guessed at. */
export function claudeModelsOf(initializeResponse: unknown): AvailableModel[] {
  const models = (initializeResponse as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: AvailableModel[] = [];
  for (const entry of models.slice(0, MAX_MODELS)) {
    const id = modelId((entry as { value?: unknown } | null)?.value);
    if (id === undefined) continue;
    const e = entry as { displayName?: unknown; description?: unknown; resolvedModel?: unknown };
    const description = text(e.description);
    const resolved = modelId(e.resolvedModel);
    out.push({
      modelId: id,
      name: text(e.displayName) ?? id,
      ...(description === undefined ? {} : { description }),
      ...(resolved === undefined ? {} : { resolvedModel: resolved }),
      ...(id === 'default' ? { isDefault: true } : {}),
    });
  }
  return out;
}

/** The models in one page of Codex's `model/list` (`data`). Hidden ones are left out unless asked for. */
export function codexModelsOf(page: unknown, includeHidden = false): AvailableModel[] {
  const data = (page as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: AvailableModel[] = [];
  for (const entry of data.slice(0, MAX_MODELS)) {
    const e = entry as { id?: unknown; model?: unknown; displayName?: unknown; description?: unknown; hidden?: unknown; isDefault?: unknown };
    if (e?.hidden === true && !includeHidden) continue;
    const id = modelId(e?.id) ?? modelId(e?.model);
    if (id === undefined) continue;
    const description = text(e.description);
    const resolved = modelId(e.model);
    out.push({
      modelId: id,
      name: text(e.displayName) ?? id,
      ...(description === undefined ? {} : { description }),
      ...(resolved === undefined || resolved === id ? {} : { resolvedModel: resolved }),
      ...(e.isDefault === true ? { isDefault: true } : {}),
    });
  }
  return out;
}

export interface ListModelsOptions {
  /** The CLI to ask. Default `claude` / `codex`. */
  readonly binary?: string;
  readonly binaryArgs?: readonly string[];
  /** Working directory for the short-lived CLI. Default: the current directory. */
  readonly cwd?: string;
  /** Parent environment to build the child's from. Default `process.env`. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Extra environment names to pass through. */
  readonly allowEnv?: readonly string[];
  /** How long to wait for the answer. Default 30 s. */
  readonly timeoutMs?: number;
  /** Codex only: include models the provider hides from its own picker. */
  readonly includeHidden?: boolean;
}

/**
 * Ask a provider which models the signed-in account offers, without starting a session or running a turn: for a
 * picker shown before any session exists. Starts the CLI under the same process-tree supervision as a session, asks,
 * and ends it. `currentModelId` is the provider's default here, since no session has chosen one.
 */
export async function listModels(provider: 'claude' | 'codex', options: ListModelsOptions = {}): Promise<SessionModelState> {
  const { env } = childEnv(options.parentEnv ?? process.env, {
    allow: provider === 'claude'
      ? ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', ...(options.allowEnv ?? [])]
      : ['CODEX_HOME', 'CODEX_CONFIG_DIR', 'XDG_CONFIG_HOME', ...(options.allowEnv ?? [])],
  });
  const args = provider === 'claude'
    ? ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']
    : ['app-server', '--listen', 'stdio://'];
  const child = launchProvider(options.binary ?? provider, [...(options.binaryArgs ?? []), ...args], { cwd: options.cwd ?? process.cwd(), env });
  const framer = new NdjsonFramer();
  const waiters = new Map<string, { resolve: (frame: Record<string, unknown>) => void; reject: (cause: Error) => void }>();
  child.child.stdout?.on('data', (chunk: Buffer) => {
    for (const frame of framer.push(chunk)) {
      if (!frame.ok || typeof frame.value !== 'object' || frame.value === null) continue;
      const value = frame.value as Record<string, unknown>;
      const id = provider === 'claude'
        ? String((value.response as { request_id?: unknown } | undefined)?.request_id ?? '')
        : String(value.id ?? '');
      const waiter = waiters.get(id);
      if (waiter !== undefined && (provider === 'claude' ? value.type === 'control_response' : value.method === undefined)) {
        waiters.delete(id);
        waiter.resolve(value);
      }
    }
  });
  child.child.stderr?.resume();
  child.child.once('close', () => {
    for (const waiter of waiters.values()) waiter.reject(new ModelListError(`${provider} exited before answering the model list`));
    waiters.clear();
  });
  const deadline = options.timeoutMs ?? 30_000;
  const ask = (id: string, frame: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelListError(`${provider} did not answer the model list within ${deadline} ms`)), deadline);
    timer.unref();
    waiters.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (cause) => { clearTimeout(timer); reject(cause); },
    });
    child.child.stdin?.write(encodeLine(frame));
  });

  try {
    await child.started;
    if (provider === 'claude') {
      const id = `prism-acp-models-${randomBytes(4).toString('hex')}`;
      const answer = (await ask(id, { type: 'control_request', request_id: id, request: { subtype: 'initialize' } })).response as
        { subtype?: unknown; error?: unknown; response?: unknown } | undefined;
      if (answer?.subtype !== 'success') throw new ModelListError('claude refused the initialize request');
      const models = claudeModelsOf(answer.response);
      return { availableModels: models, currentModelId: models.find((m) => m.isDefault)?.modelId ?? null };
    }
    let next = 0;
    const request = async (method: string, params: unknown) => {
      const id = String(++next);
      const answer = await ask(id, { jsonrpc: '2.0', id: next, method, params });
      if (answer.error !== undefined) throw new ModelListError(`codex refused ${method}`);
      return answer.result;
    };
    await request('initialize', { clientInfo: { name: '@particle-academy/prism-acp', version: '0' }, capabilities: {} });
    child.child.stdin?.write(encodeLine({ jsonrpc: '2.0', method: 'initialized' }));
    const models: AvailableModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await request('model/list', { cursor, includeHidden: options.includeHidden ?? false }) as { nextCursor?: unknown } | undefined;
      models.push(...codexModelsOf(result, options.includeHidden ?? false));
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : null;
      if (cursor === null) break;
    }
    return { availableModels: models, currentModelId: models.find((m) => m.isDefault)?.modelId ?? null };
  } finally {
    await child.stop({ graceMs: 0 });
  }
}
