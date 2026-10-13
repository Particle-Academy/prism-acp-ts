import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcpAgent, type AcpAgentOptions, type AgentDriver, type DriverEvents } from '../src/acp/agent.js';
import { CLAUDE_DRIVER_CAPABILITIES, ClaudeDriver, promptLine } from '../src/claude/driver.js';
import { CODEX_DRIVER_CAPABILITIES, CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';
import { PromptRefused, type PromptBlock, type PromptContent } from '../src/prompt.js';

/**
 * PROMPTS ARE CONTENT BLOCKS (issue #4). A client's attachment is an image or a file, and ACP's session/prompt has
 * always carried them as content blocks -- but every driver took a string, and the agent flattened the prompt to its
 * text, so an image beside a sentence was DROPPED without a word. Now each driver maps the blocks onto its provider's
 * documented input, declares which kinds it takes, and REFUSES the whole prompt -- naming the block -- rather than
 * sending part of what the person attached.
 */

// A 1x1 PNG. The bytes only have to survive the trip; the live proof asks a real model about a real picture.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const text = (t: string): PromptBlock => ({ type: 'text', text: t });
const image = (mimeType = 'image/png', data = PNG): PromptBlock => ({ type: 'image', mimeType, data });
const textFile: PromptBlock = {
  type: 'resource',
  resource: { uri: 'file:///work/notes.md', mimeType: 'text/markdown', text: '# Notes\nsecond line' },
};
const blobFile: PromptBlock = {
  type: 'resource',
  resource: { uri: 'file:///work/report.pdf', mimeType: 'application/pdf', blob: 'JVBERi0=' },
};

describe('what each driver declares it takes', () => {
  it('Claude and Codex both take text, images and text files -- and say so', () => {
    expect(CLAUDE_DRIVER_CAPABILITIES.promptBlocks).toEqual(['text', 'image', 'resource-text']);
    expect(CODEX_DRIVER_CAPABILITIES.promptBlocks).toEqual(['text', 'image', 'resource-text']);
  });
});

describe('Claude: the stream-json user message', () => {
  const content = (c: PromptContent): unknown[] =>
    (JSON.parse(promptLine(c)) as { message: { content: unknown[] } }).message.content;

  it('a string is still one text block (unchanged)', () => {
    expect(content('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('an image is the documented base64 image block, beside the text, in order', () => {
    expect(content([text('what colour?'), image()])).toEqual([
      { type: 'text', text: 'what colour?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
  });

  it('a text file is a text block that names the file and carries its text', () => {
    const [block] = content([textFile]) as Array<{ type: string; text: string }>;
    expect(block?.type).toBe('text');
    expect(block?.text).toContain('file:///work/notes.md');
    expect(block?.text).toContain('# Notes\nsecond line');
  });

  it('REFUSES what it cannot take, naming the block -- counted over every refused kind', () => {
    const refused: PromptBlock[] = [
      image('image/bmp'),
      blobFile,
      { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' } as unknown as PromptBlock,
      { type: 'resource_link', uri: 'file:///x', name: 'x' } as unknown as PromptBlock,
      image('image/png', ''),
    ];
    const named = refused.filter((b) => {
      try {
        promptLine([text('see'), b]);
        return false;
      } catch (e) {
        return e instanceof PromptRefused && e.index === 1 && /block 2/.test(e.message);
      }
    });
    expect(named).toHaveLength(refused.length);
  });

  it('the driver refuses before writing anything', () => {
    const driver = new ClaudeDriver({ cwd: '/work', parentEnv: {} }, {});
    expect(() => driver.prompt([blobFile])).toThrow(PromptRefused);
  });
});

class Fake implements CodexTransport {
  readonly sent: Record<string, unknown>[] = [];
  constructor(private readonly handlers: CodexTransportHandlers) {}
  async start(): Promise<void> {}
  send(raw: unknown): void {
    const f = raw as Record<string, unknown>;
    this.sent.push(f);
    if (typeof f.method !== 'string' || typeof f.id !== 'number') return;
    const result =
      f.method === 'thread/start' ? { thread: { id: 'thread-1' } } : f.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
    queueMicrotask(() => this.handlers.onFrame({ jsonrpc: '2.0', id: f.id, result }));
  }
  close(): void {}
}

async function codex() {
  let transport!: Fake;
  const factory: CodexTransportFactory = (_o, h) => (transport = new Fake(h));
  const driver = new CodexDriver({ cwd: '/work', parentEnv: {} }, {}, factory);
  driver.start();
  await driver.ready;
  const input = async (): Promise<Array<Record<string, unknown>>> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const start = transport.sent.find((f) => f.method === 'turn/start');
    return (start?.params as { input: Array<Record<string, unknown>> }).input;
  };
  return { driver, input };
}

describe('Codex: turn/start input items', () => {
  it('an image is a localImage whose file holds exactly the bytes, in a private directory removed when the session ends', async () => {
    const c = await codex();
    c.driver.prompt([text('what colour?'), image(), textFile]);
    const items = await c.input();
    expect(items.map((i) => i.type)).toEqual(['text', 'localImage', 'text']);
    const path = items[1]!.path as string;
    expect(readFileSync(path).equals(Buffer.from(PNG, 'base64'))).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(items[2]!.text).toContain('file:///work/notes.md');
    c.driver.kill();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('REFUSES a file it cannot take -- synchronously, naming it, with no turn started and the next prompt still accepted', async () => {
    const c = await codex();
    expect(() => c.driver.prompt([text('read this'), blobFile])).toThrow(/block 2/);
    c.driver.prompt('fine');
    expect((await c.input()).map((i) => i.type)).toEqual(['text']);
    c.driver.kill();
  });
});

class Recorder implements AgentDriver {
  readonly prompts: PromptContent[] = [];
  cliSessionId = null;
  withheldCredentials: readonly string[] = [];
  constructor(readonly events: DriverEvents) {}
  start(): void {}
  prompt(content: PromptContent): void {
    this.prompts.push(content);
    this.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
  }
  endInput(): void {}
  kill(): void {}
}

async function agent(driverCapabilities?: AcpAgentOptions['driverCapabilities']) {
  const sent: Record<string, unknown>[] = [];
  const peer = new JsonRpcPeer({ send: (m) => sent.push(m as Record<string, unknown>) });
  const drivers: Recorder[] = [];
  new AcpAgent(peer, {
    driverFactory: (_o, e) => {
      const d = new Recorder(e);
      drivers.push(d);
      return d;
    },
    newSessionId: () => 's1',
    ...(driverCapabilities ? { driverCapabilities } : {}),
  });
  const call = async (method: string, params: unknown, id: number): Promise<Record<string, unknown>> => {
    await peer.receive({ jsonrpc: '2.0', id, method, params });
    return sent.find((m) => m.id === id) ?? {};
  };
  await call('session/new', { cwd: '/work', mcpServers: [] }, 1);
  return { call, drivers, sent };
}

describe('the ACP agent', () => {
  it('passes an image through to a driver that takes images -- not flattened to its text', async () => {
    const a = await agent(CLAUDE_DRIVER_CAPABILITIES);
    const reply = await a.call('session/prompt', { sessionId: 's1', prompt: [text('what colour?'), image()] }, 2);
    expect(reply.result).toEqual({ stopReason: 'end_turn' });
    expect(a.drivers[0]!.prompts).toEqual([[text('what colour?'), image()]]);
  });

  it('a text-only driver: an image beside text is REFUSED naming it, never dropped (it used to be dropped)', async () => {
    const a = await agent({ permissionRequests: false, transcriptReplay: false });
    const reply = await a.call('session/prompt', { sessionId: 's1', prompt: [text('what colour?'), image()] }, 2);
    expect((reply.error as { message: string } | undefined)?.message).toMatch(/block 2.*image/);
    expect(a.drivers[0]!.prompts).toEqual([]);
  });

  it('initialize says image and embeddedContext from the declaration', async () => {
    const a = await agent(CODEX_DRIVER_CAPABILITIES);
    const init = await a.call('initialize', {}, 3);
    const caps = ((init.result as Record<string, unknown>).agentCapabilities as Record<string, unknown>).promptCapabilities;
    expect(caps).toEqual({ image: true, audio: false, embeddedContext: true });
  });
});
