import { describe, expect, it } from 'vitest';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import type { TurnOutcome } from '../src/claude/driver.js';
import { ClaudeTurnFailures } from '../src/turn-failure.js';

/**
 * A TURN THAT FAILS ON A LIMIT SAYS SO, STRUCTURALLY (tynn #791). Genie marks a turn "held by the limit" only when a
 * rate-limit event arrived during it; a turn the CLI ended with an error and no event showed as "failed" and was never
 * resumed after the reset. The reason is on the provider's own frames:
 *   Claude: the assistant message's `error` (claude-code 2.1.301's schema: authentication_failed, oauth_org_not_allowed,
 *           account_on_hold, verification_required, billing_error, rate_limit, overloaded, invalid_request,
 *           model_not_found, server_error, unknown, max_output_tokens, cloud_credential_error).
 *   Codex:  the failed turn's `error.codexErrorInfo` (codex-cli 0.156.1's schema).
 * A reset time is reported only when a rate-limit event in the same turn gave one -- never invented.
 */

const assistantError = (error: string, parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'msg_1', content: [] }, error });
const limitEvent = (status: string, resetsAt: number) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, resetsAt, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt } } },
});
const failedResult = { type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null };

function claudeTurn(frames: unknown[]) {
  const tracker = new ClaudeTurnFailures();
  for (const frame of frames) tracker.observe(frame);
  return tracker.take();
}

describe('Claude: the failure reason rides on the turn outcome', () => {
  it('a turn the CLI ends on rate_limit, with NO rate_limit_event, carries rate_limit', () => {
    expect(claudeTurn([assistantError('rate_limit'), failedResult])).toEqual({ reason: 'rate_limit', kind: 'rate_limit' });
  });

  it('the same failed turn without the field carries nothing (the control)', () => {
    expect(claudeTurn([failedResult])).toBeUndefined();
  });

  it('carries the reset time only when a breached rate-limit event in the turn said when', () => {
    expect(claudeTurn([limitEvent('rejected', 1_792_302_600), assistantError('rate_limit'), failedResult]))
      .toEqual({ reason: 'rate_limit', kind: 'rate_limit', resetsAtMs: 1_792_302_600_000 });
    // An `allowed` event is not a breach, and its reset is not the reset of this failure.
    expect(claudeTurn([limitEvent('allowed', 1_792_302_600), assistantError('rate_limit'), failedResult]))
      .toEqual({ reason: 'rate_limit', kind: 'rate_limit' });
  });

  it.each([
    ['overloaded', 'overloaded'], ['authentication_failed', 'auth'], ['oauth_org_not_allowed', 'auth'],
    ['cloud_credential_error', 'auth'], ['billing_error', 'billing'], ['account_on_hold', 'billing'],
    ['server_error', 'other'], ['a_reason_added_next_month', 'other'],
  ])('classifies %s as %s, keeping the reason verbatim', (reason, kind) => {
    expect(claudeTurn([assistantError(reason), failedResult])).toEqual({ reason, kind });
  });

  it('ignores a SUBAGENT\'s error: it is not this turn\'s failure', () => {
    expect(claudeTurn([assistantError('rate_limit', 'toolu_task'), failedResult])).toBeUndefined();
  });

  it('does not carry one turn\'s failure into the next', () => {
    const tracker = new ClaudeTurnFailures();
    tracker.observe(limitEvent('rejected', 1_792_302_600));
    tracker.observe(assistantError('rate_limit'));
    tracker.take();
    tracker.observe(failedResult);
    expect(tracker.take()).toBeUndefined();
  });
});

class Transport implements CodexTransport {
  readonly #handlers: CodexTransportHandlers;
  constructor(handlers: CodexTransportHandlers) { this.#handlers = handlers; }
  async start(): Promise<void> {}
  send(raw: unknown): void {
    const frame = raw as Record<string, unknown>;
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    let result: unknown = {};
    if (frame.method === 'thread/start') result = { thread: { id: 'thread-1' } };
    if (frame.method === 'turn/start') result = { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
    if (frame.method === 'account/rateLimits/read') result = { rateLimits: { primary: null, secondary: null } };
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }
  close(): void {}
  frame(value: unknown): void { this.#handlers.onFrame(value); }
}

async function codexFailedTurn(error: unknown): Promise<TurnOutcome> {
  let transport!: Transport;
  const ends: TurnOutcome[] = [];
  const factory: CodexTransportFactory = (_o, handlers) => (transport = new Transport(handlers));
  const driver = new CodexDriver({ cwd: '/w', parentEnv: {} }, { onTurnEnd: (o) => ends.push(o) }, factory);
  driver.start();
  await new Promise<void>((r) => setImmediate(r));
  driver.prompt('hi');
  await new Promise<void>((r) => setImmediate(r));
  transport.frame({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
  transport.frame({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: {
    id: 'turn-1', status: 'failed', items: [], ...(error === undefined ? {} : { error }),
  } } });
  await new Promise<void>((r) => setImmediate(r));
  expect(ends).toHaveLength(1);
  return ends[0]!;
}

describe('Codex: the failure reason rides on the turn outcome', () => {
  it('usageLimitExceeded is a rate_limit failure, with no reset invented', async () => {
    const outcome = await codexFailedTurn({ message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' });
    expect(outcome.isError).toBe(true);
    expect(outcome.failure).toEqual({ reason: 'usageLimitExceeded', kind: 'rate_limit' });
  });

  it('names an object variant by its key', async () => {
    const outcome = await codexFailedTurn({ message: 'connect failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } });
    expect(outcome.failure).toEqual({ reason: 'httpConnectionFailed', kind: 'other' });
  });

  it('a failed turn with no error info carries nothing (the control)', async () => {
    expect((await codexFailedTurn(undefined)).failure).toBeUndefined();
  });
});
