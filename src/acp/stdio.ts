/**
 * Serve the ACP agent over a pipe.
 *
 * ACP runs over stdio: the client spawns the agent and they exchange NDJSON on
 * its stdin and stdout. This is the fifteen lines that join {@link NdjsonFramer},
 * {@link JsonRpcPeer} and {@link AcpAgent} to a pair of streams.
 *
 * Streams are parameters rather than `process.stdin`/`process.stdout` reached
 * for directly, so the whole surface can be driven end to end in a test over a
 * pair of in-memory streams -- no spawning, no pipes, no timing.
 */
import type { Readable, Writable } from 'node:stream';
import { JsonRpcPeer } from '../jsonrpc.js';
import { NdjsonFramer, encodeLine } from '../ndjson.js';
import { AcpAgent, type AcpAgentOptions } from './agent.js';

export interface ServeOptions extends AcpAgentOptions {
  readonly input: Readable;
  readonly output: Writable;
  /** A frame that arrived but was not usable. */
  readonly onProtocolError?: (sessionId: string, problem: string) => void;
}

export interface Served {
  readonly agent: AcpAgent;
  readonly peer: JsonRpcPeer;
  /** Resolves when the input stream ends. */
  readonly closed: Promise<void>;
}

export function serve(options: ServeOptions): Served {
  const framer = new NdjsonFramer();

  const peer = new JsonRpcPeer({
    send: (message) => {
      options.output.write(encodeLine(message));
    },
    onProtocolError: (problem) => options.onProtocolError?.('', problem),
  });

  const agent = new AcpAgent(peer, options);

  const closed = new Promise<void>((resolve) => {
    let finished = false;
    options.input.on('data', (chunk: Buffer | string) => {
      for (const frame of framer.push(chunk)) deliver(frame);
    });

    const closeClient = (flush: boolean, reason: string) => {
      if (finished) return;
      finished = true;
      // Flush before closing: a client can send its last message without a
      // trailing newline, and on this transport the last message is the one
      // that matters.
      if (flush) for (const frame of framer.end()) deliver(frame);
      // Every session's child process outlives this stream unless it is told
      // otherwise. A server that exited without killing them would leave an
      // agent running with nobody listening.
      agent.closeAll();
      peer.fail(new Error(reason));
      resolve();
    };

    options.input.on('end', () => closeClient(true, 'client disconnected'));
    // Destroyed pipes may emit `close` without `end`. That is a disconnect too:
    // pending provider approvals must be cancelled before their socket closes.
    options.input.on('close', () => closeClient(false, 'client disconnected'));
    options.input.on('error', () => closeClient(false, 'client input failed'));
  });

  function deliver(frame: ReturnType<NdjsonFramer['push']>[number]): void {
    if (!frame.ok) {
      options.onProtocolError?.('', frame.error.message);
      return;
    }
    void peer.receive(frame.value);
  }

  return { agent, peer, closed };
}
