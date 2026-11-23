import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardRemoteControl } from '../src/codex/driver.js';
import { StdioCodexTransport } from '../src/codex/transport.js';
import { RemoteControlRefused } from '../src/remote-control.js';

/**
 * What the Codex transport writes is what it checked: one JSON-RPC object per line, with no remoteControl method in the
 * serialized bytes, however the value handed to `send` is built.
 */

vi.mock('node:child_process', async () => ({ ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawn: vi.fn() }));
vi.mock('../src/process-tree.js', async () => ({
  ...await vi.importActual<typeof import('../src/process-tree.js')>('../src/process-tree.js'),
  launchProvider: (await import('./fake-launch.js')).fakeLaunch,
}));

class CodexChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; pid = 4242;
  constructor() { super(); queueMicrotask(() => this.emit('spawn')); }
  kill(): boolean { this.exitCode = 0; this.emit('close', 0, null); return true; }
}

const handlers = { onFrame: () => {}, onStderr: () => {}, onProblem: () => {}, onExit: () => {} };
let child: CodexChild;
let written: string;
let transport: StdioCodexTransport;

beforeEach(async () => {
  written = '';
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation((() => {
    child = new CodexChild();
    child.stdin.on('data', (chunk: Buffer) => { written += chunk.toString(); });
    return child as unknown as ChildProcess;
  }) as never);
  transport = new StdioCodexTransport({ cwd: process.cwd(), env: {} }, handlers);
  await transport.start();
});
afterEach(() => transport.close());

const flushed = async (): Promise<string> => { await new Promise((resolve) => setImmediate(resolve)); return written; };

const spellings = ['remoteControl/enable', 'remoteControl', ' remoteControl/enable', 'REMOTECONTROL/ENABLE', 'remote​Control/enable', '﻿remoteControl/status', 'remoteControl\t/enable'];
const request = (method: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: 1, method });
const benign = { jsonrpc: '2.0', id: 2, method: 'thread/start' };

/** A value whose `method` reads as harmless the first time and as the refused name afterwards. */
function changingGetter(): unknown {
  let reads = 0;
  return { jsonrpc: '2.0', id: 1, get method() { return reads++ === 0 ? 'thread/start' : 'remoteControl/enable'; } };
}

describe('Codex list frames', () => {
  it.each(spellings)('refuses a list carrying %j, writing nothing', async (method) => {
    expect(() => transport.send([request(method)])).toThrow(RemoteControlRefused);
    expect(() => transport.send([benign, request(method)])).toThrow(RemoteControlRefused);
    expect(() => transport.send([[request(method)]])).toThrow(RemoteControlRefused);
    expect(() => transport.send([benign, [benign, [request(method)]]])).toThrow(RemoteControlRefused);
    expect(await flushed()).toBe('');
  });

  it('refuses every list frame, because nothing in the driver sends one', async () => {
    expect(() => transport.send([])).toThrow(RemoteControlRefused);
    expect(() => transport.send([benign])).toThrow(RemoteControlRefused);
    expect(await flushed()).toBe('');
  });

  it('refuses a value that serializes to a list', async () => {
    expect(() => transport.send({ toJSON: () => [request('remoteControl/enable')] })).toThrow(RemoteControlRefused);
    expect(await flushed()).toBe('');
  });

  it('refuses a list at the guard every driver transport passes through, before any custom transport', () => {
    const received: unknown[] = [];
    const guarded = guardRemoteControl({ start: async () => {}, close: () => {}, send: (frame: unknown) => { received.push(frame); } });
    expect(() => guarded.send([request('remoteControl/enable')])).toThrow(RemoteControlRefused);
    expect(() => guarded.send([[request(' REMOTECONTROL/ENABLE')]])).toThrow(RemoteControlRefused);
    expect(() => guarded.send({ toJSON: () => [benign] })).toThrow(RemoteControlRefused);
    expect(received).toEqual([]);
  });
});

describe('Codex frames are checked as written', () => {
  it.each(spellings)('refuses a value that serializes to %j', async (method) => {
    expect(() => transport.send({ toJSON: () => request(method) })).toThrow(RemoteControlRefused);
    expect(await flushed()).toBe('');
  });

  it('never writes a refused method from a value that reads differently on a later access', async () => {
    try { transport.send(changingGetter()); } catch (cause) { expect(cause).toBeInstanceOf(RemoteControlRefused); }
    expect((await flushed()).toLowerCase()).not.toContain('remotecontrol');
  });

  it('hands a custom transport the value it checked, not the original', () => {
    const received: unknown[] = [];
    const guarded = guardRemoteControl({ start: async () => {}, close: () => {}, send: (frame: unknown) => { received.push(frame); } });
    try { guarded.send(changingGetter()); } catch (cause) { expect(cause).toBeInstanceOf(RemoteControlRefused); }
    expect(JSON.stringify(received).toLowerCase()).not.toContain('remotecontrol');
  });

  it('writes ordinary frames byte for byte (the positive control)', async () => {
    const frames = [
      benign,
      { jsonrpc: '2.0', id: 3, result: [{ method: 'remoteControl/enable' }] },
      { jsonrpc: '2.0', method: 'turn/start', params: { input: [{ type: 'text', text: 'remoteControl/enable' }] } },
      { method: 'remoteControlled/x' },
    ];
    for (const frame of frames) transport.send(frame);
    transport.send({ toJSON: () => benign });
    expect(await flushed()).toBe([...frames, benign].map((frame) => `${JSON.stringify(frame)}\n`).join(''));
  });
});
