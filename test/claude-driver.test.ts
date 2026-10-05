import { describe, expect, it } from 'vitest';
import {
  ClaudeDriver,
  claudeArgs,
  promptLine,
  updatesFromFrames,
} from '../src/claude/driver.js';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import { NdjsonFramer } from '../src/ndjson.js';

describe('claudeArgs — the flags, which cannot be checked by spawning', () => {
  const base = { cwd: '/w' };

  it('asks for a bidirectional structured stream', () => {
    // This combination is the whole reason no third-party adapter is needed.
    const args = claudeArgs(base);
    expect(args).toContain('--print');
    expect(args.join(' ')).toContain('--output-format stream-json');
    expect(args.join(' ')).toContain('--input-format stream-json');
  });

  it('passes --verbose, which stream-json REQUIRES', () => {
    // Verified against the binary: without it the CLI refuses the combination.
    // Easy to drop as noise, and the failure is a refusal at spawn time.
    expect(claudeArgs(base)).toContain('--verbose');
  });

  it('passes --include-partial-messages, without which there are no deltas', () => {
    // Omit it and the reply arrives in one lump: no agent_message_chunk, no
    // agent_thought_chunk, and the point of a streaming transport is gone
    // while everything still appears to work.
    expect(claudeArgs(base)).toContain('--include-partial-messages');
  });

  it('resumes a session when asked', () => {
    const args = claudeArgs({ ...base, resumeSessionId: 'abc-123' });
    expect(args.join(' ')).toContain('--resume abc-123');
  });

  it('omits --resume when not resuming', () => {
    // A wrong resume flag does not error -- it starts a FRESH conversation
    // while the caller believes it continued one.
    expect(claudeArgs(base).join(' ')).not.toContain('--resume');
  });

  it('passes a permission mode through', () => {
    expect(claudeArgs({ ...base, permissionMode: 'plan' }).join(' ')).toContain(
      '--permission-mode plan',
    );
  });

  it('joins tool lists with commas', () => {
    const args = claudeArgs({ ...base, allowedTools: ['Read', 'Grep'] }).join(' ');
    expect(args).toContain('--allowed-tools Read,Grep');
  });

  it('omits an EMPTY tool list rather than passing an empty value', () => {
    // `--allowed-tools ""` is not the same as no restriction, and the two
    // differ in the direction that matters: one permits nothing.
    const args = claudeArgs({ ...base, allowedTools: [], disallowedTools: [] }).join(' ');
    expect(args).not.toContain('--allowed-tools');
    expect(args).not.toContain('--disallowed-tools');
  });
});

describe('promptLine', () => {
  it('wraps the text in the message envelope the CLI expects', () => {
    // Not a bare string: the CLI expects the same envelope it emits.
    const parsed = JSON.parse(promptLine('hello')) as Record<string, unknown>;
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
  });

  it('ends with exactly one newline, because the transport is line-delimited', () => {
    const line = promptLine('x');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
  });

  it('escapes a newline inside the prompt instead of breaking the framing', () => {
    // A multi-line prompt must not become two frames. JSON.stringify handles
    // it, but the property is worth pinning: a prompt is user input, and user
    // input that can split a frame is a protocol injection.
    const line = promptLine('first\nsecond');
    expect(line.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    const parsed = JSON.parse(line) as { message: { content: Array<{ text: string }> } };
    expect(parsed.message.content[0]?.text).toBe('first\nsecond');
  });
});

describe('driver lifecycle, without spawning', () => {
  it('refuses to prompt before it is started', () => {
    // Otherwise the write is silently lost and the caller waits for a reply to
    // a prompt that was never sent.
    const driver = new ClaudeDriver({ cwd: '/w' });
    expect(() => driver.prompt('hi')).toThrow(/not started/);
  });

  it('is not running before start', () => {
    expect(new ClaudeDriver({ cwd: '/w' }).running).toBe(false);
  });

  it('reports no withheld credentials before start', () => {
    // Empty because nothing was examined yet -- not because nothing was found.
    expect(new ClaudeDriver({ cwd: '/w' }).withheldCredentials).toEqual([]);
  });
});

describe('the wiring: framed output reaching the mapper, both outcomes reaching the caller', () => {
  // Tested through `updatesFromFrames` rather than by spawning a stand-in
  // binary. The driver appends claudeArgs() to whatever binary it is given, so
  // a stand-in would have to tolerate `--output-format stream-json` -- and
  // `node` does not; it tries to evaluate it. Adding a spawn hook to the driver
  // purely so a test could reach it would be API surface invented for a test.
  // Process handling is covered by the opt-in live test instead; this covers
  // the part that would otherwise have no test in CI at all.
  function framesFor(text: string) {
    const framer = new NdjsonFramer();
    return [...framer.push(text), ...framer.end()];
  }

  it('maps framed bytes into updates', () => {
    const frame = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    });
    const { updates, problems } = updatesFromFrames(framesFor(`${frame}\n`), new ClaudeToAcp());
    expect(problems).toEqual([]);
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    ]);
  });

  it('reports a framing failure as a problem instead of losing it', () => {
    const { updates, problems } = updatesFromFrames(framesFor('{not json\n'), new ClaudeToAcp());
    expect(updates).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not valid JSON/);
  });

  it('keeps going after a bad frame rather than abandoning the stream', () => {
    // One corrupt line must not cost the rest of a turn -- including the
    // `result` frame that carries the outcome.
    const good = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    });
    const { updates, problems } = updatesFromFrames(
      framesFor(`{bad\n${good}\n`),
      new ClaudeToAcp(),
    );
    expect(problems).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it('shares one mapper across calls, so block state survives chunk boundaries', () => {
    // A tool call's identity arrives in one frame and its arguments across
    // many. A driver that built a fresh mapper per chunk would lose the
    // association and silently emit tool calls with no arguments.
    const mapper = new ClaudeToAcp();
    const start = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      },
    });
    const delta = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
      },
    });
    const stop = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });

    updatesFromFrames(framesFor(`${start}\n`), mapper);
    updatesFromFrames(framesFor(`${delta}\n`), mapper);
    const { updates } = updatesFromFrames(framesFor(`${stop}\n`), mapper);

    expect(updates[0]).toMatchObject({ toolCallId: 't1', rawInput: { a: 1 } });
  });
});
