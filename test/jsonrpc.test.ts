import { describe, expect, it, vi } from 'vitest';
import {
  JsonRpcPeer,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  RpcError,
} from '../src/jsonrpc.js';

/** A peer whose outbound messages are collected instead of written anywhere. */
function peerWithSink() {
  const sent: Record<string, unknown>[] = [];
  const problems: string[] = [];
  const peer = new JsonRpcPeer({
    send: (m) => sent.push(m as Record<string, unknown>),
    onProtocolError: (p) => problems.push(p),
  });
  return { peer, sent, problems };
}

describe('outbound requests', () => {
  it('sends a well-formed request and resolves on its response', async () => {
    const { peer, sent } = peerWithSink();
    const promise = peer.request('session/prompt', { text: 'hi' });

    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: 1,
      params: { text: 'hi' },
    });

    await peer.receive({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
    await expect(promise).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('omits params entirely when there are none', async () => {
    // `"params": null` is not the same as no params, and a strict peer is
    // entitled to reject it.
    const { peer, sent } = peerWithSink();
    void peer.request('initialize');
    expect('params' in sent[0]!).toBe(false);
  });

  it('rejects with the code and data the far side sent', async () => {
    const { peer } = peerWithSink();
    const promise = peer.request('fs/read_text_file');
    await peer.receive({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'bad path', data: { path: '/x' } },
    });
    await expect(promise).rejects.toMatchObject({ code: -32602, message: 'bad path' });
  });

  it('correlates strictly by id, with responses OUT OF ORDER', async () => {
    // Nothing in the spec promises response ordering, so nothing here may
    // depend on it. A peer that paired responses positionally would pass every
    // single-request test and corrupt every concurrent one.
    const { peer } = peerWithSink();
    const first = peer.request('a');
    const second = peer.request('b');

    await peer.receive({ jsonrpc: '2.0', id: 2, result: 'B' });
    await peer.receive({ jsonrpc: '2.0', id: 1, result: 'A' });

    await expect(first).resolves.toBe('A');
    await expect(second).resolves.toBe('B');
  });

  it('does not leave a caller waiting when the transport refuses the write', async () => {
    const peer = new JsonRpcPeer({
      send: () => {
        throw new Error('pipe closed');
      },
    });
    await expect(peer.request('x')).rejects.toThrow(/pipe closed/);
    expect(peer.inFlight).toBe(0);
  });

  it('tracks in-flight count', async () => {
    const { peer } = peerWithSink();
    void peer.request('a');
    void peer.request('b');
    expect(peer.inFlight).toBe(2);
    await peer.receive({ jsonrpc: '2.0', id: 1, result: null });
    expect(peer.inFlight).toBe(1);
  });
});

describe('inbound requests — the decisions that stop a hang', () => {
  it('answers an UNKNOWN method with an error rather than silence', async () => {
    // The decision that matters most. A peer awaiting a response it will never
    // get does not fail -- it parks forever, looking exactly like an agent that
    // is thinking.
    const { peer, sent } = peerWithSink();
    await peer.receive({ jsonrpc: '2.0', id: 7, method: 'terminal/create' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: RPC_METHOD_NOT_FOUND },
    });
  });

  it('answers a THROWING handler with an error rather than silence', async () => {
    const { peer, sent } = peerWithSink();
    peer.handle('fs/read_text_file', () => {
      throw new Error('disk on fire');
    });
    await peer.receive({ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file' });

    expect(sent[0]).toMatchObject({
      id: 1,
      error: { code: RPC_INTERNAL_ERROR, message: 'disk on fire' },
    });
  });

  it('answers a REJECTING async handler too', async () => {
    const { peer, sent } = peerWithSink();
    peer.handle('x', async () => {
      await Promise.resolve();
      throw new RpcError(-32602, 'bad params', { why: 'nope' });
    });
    await peer.receive({ jsonrpc: '2.0', id: 1, method: 'x' });

    expect(sent[0]).toMatchObject({
      id: 1,
      error: { code: -32602, message: 'bad params', data: { why: 'nope' } },
    });
  });

  it('lets a handler choose the error code via RpcError', async () => {
    const { peer, sent } = peerWithSink();
    peer.handle('x', () => {
      throw new RpcError(-32001, 'refused: cwd outside workspace');
    });
    await peer.receive({ jsonrpc: '2.0', id: 1, method: 'x' });
    expect(sent[0]).toMatchObject({ error: { code: -32001 } });
  });

  it('replies with the handler result', async () => {
    const { peer, sent } = peerWithSink();
    peer.handle('fs/read_text_file', () => ({ content: 'hello' }));
    await peer.receive({ jsonrpc: '2.0', id: 3, method: 'fs/read_text_file' });
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 3, result: { content: 'hello' } });
  });

  it('replies with null rather than omitting result for a void handler', async () => {
    // A response must carry exactly one of result or error. Omitting both is
    // not a valid JSON-RPC response and a strict peer may reject it.
    const { peer, sent } = peerWithSink();
    peer.handle('x', () => undefined);
    await peer.receive({ jsonrpc: '2.0', id: 1, method: 'x' });
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, result: null });
  });
});

describe('notifications', () => {
  it('delivers params to the handler', async () => {
    const { peer } = peerWithSink();
    const seen = vi.fn();
    peer.onNotify('session/update', seen);
    await peer.receive({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } });
    expect(seen).toHaveBeenCalledWith({ a: 1 });
  });

  it('never answers a notification, even an unknown one', async () => {
    // A notification has no id and therefore no reply. Answering one would be
    // a protocol violation, and the far side has nothing waiting.
    const { peer, sent, problems } = peerWithSink();
    await peer.receive({ jsonrpc: '2.0', method: 'session/update' });
    expect(sent).toEqual([]);
    expect(problems[0]).toMatch(/unhandled notification/);
  });

  it('surfaces a throwing notification handler instead of losing it', async () => {
    const { peer, problems } = peerWithSink();
    peer.onNotify('x', () => {
      throw new Error('boom');
    });
    await peer.receive({ jsonrpc: '2.0', method: 'x' });
    expect(problems[0]).toMatch(/notification handler threw: boom/);
  });

  it('sends a notification without an id', () => {
    const { peer, sent } = peerWithSink();
    peer.notify('session/cancel', { sessionId: 's1' });
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's1' },
    });
    expect('id' in sent[0]!).toBe(false);
  });
});

describe('transport death', () => {
  it('rejects EVERY in-flight request', async () => {
    // Otherwise each pending promise hangs for the process lifetime and a dead
    // child presents as a slow one.
    const { peer } = peerWithSink();
    const a = peer.request('a');
    const b = peer.request('b');

    peer.fail(new Error('child exited with code 1'));

    await expect(a).rejects.toThrow(/child exited with code 1/);
    await expect(b).rejects.toThrow(/child exited with code 1/);
    expect(peer.inFlight).toBe(0);
  });

  it('names the method in each rejection', async () => {
    // One shared reason, but a call site should still learn which of its own
    // calls died.
    const { peer } = peerWithSink();
    const promise = peer.request('session/prompt');
    peer.fail(new Error('pipe closed'));
    await expect(promise).rejects.toThrow(/session\/prompt/);
  });

  it('refuses new requests afterwards', async () => {
    const { peer } = peerWithSink();
    peer.fail(new Error('gone'));
    expect(peer.failed).toBe(true);
    await expect(peer.request('x')).rejects.toThrow(/gone/);
    expect(() => peer.notify('y')).toThrow(/gone/);
  });

  it('is idempotent', async () => {
    const { peer } = peerWithSink();
    const promise = peer.request('a');
    peer.fail(new Error('first'));
    peer.fail(new Error('second'));
    await expect(promise).rejects.toThrow(/first/);
  });
});

describe('frames this peer cannot act on are SURFACED, not dropped', () => {
  it('reports a response for an id it never sent', async () => {
    // Means the two sides disagree about what is outstanding. Dropping it
    // silently is how a transport becomes indistinguishable from one receiving
    // nothing.
    const { peer, problems } = peerWithSink();
    await peer.receive({ jsonrpc: '2.0', id: 99, result: 'x' });
    expect(problems[0]).toMatch(/unknown id: 99/);
  });

  it('reports a duplicate response for an already-settled id', async () => {
    const { peer, problems } = peerWithSink();
    const promise = peer.request('a');
    await peer.receive({ jsonrpc: '2.0', id: 1, result: 'first' });
    await peer.receive({ jsonrpc: '2.0', id: 1, result: 'second' });
    await expect(promise).resolves.toBe('first');
    expect(problems[0]).toMatch(/unknown id: 1/);
  });

  it('reports a non-object frame', async () => {
    const { peer, problems } = peerWithSink();
    await peer.receive(42);
    await peer.receive(null);
    await peer.receive(['a']);
    expect(problems).toHaveLength(3);
  });

  it('reports a frame with neither method nor id', async () => {
    const { peer, problems } = peerWithSink();
    await peer.receive({ jsonrpc: '2.0' });
    expect(problems[0]).toMatch(/neither a method nor an id/);
  });

  it('accepts a STRING id, which JSON-RPC permits', async () => {
    const { peer, sent } = peerWithSink();
    peer.handle('x', () => 'ok');
    await peer.receive({ jsonrpc: '2.0', id: 'abc', method: 'x' });
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 'abc', result: 'ok' });
  });
});
