import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalPipe } from '../src/process-tree-local.js';

const endpoints: LocalPipe[] = [];
const sockets: Socket[] = [];
const servers: Server[] = [];
const key = '11'.repeat(32), nonce = '22'.repeat(32);
const proof = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');
afterEach(() => { for (const socket of sockets.splice(0)) socket.destroy(); for (const endpoint of endpoints.splice(0)) endpoint.close(); for (const server of servers.splice(0)) server.close(); });

describe.runIf(process.platform === 'win32')('LOCAL endpoint authentication', () => {
  async function open(timeout = 1000) {
    const accepted: Buffer[] = [];
    const endpoint = new LocalPipe('stdout', key, timeout, (socket, tail) => {
      accepted.push(Buffer.from(tail));
      socket.on('data', (bytes: Buffer) => accepted.push(Buffer.from(bytes))); socket.resume();
      socket.write('private-specification\n');
    }, () => {});
    endpoints.push(endpoint);
    // Owned impostor server exercises the client boundary. Production servers
    // are created with explicit ACLs by the C# supervisor, never by node:net.
    const server = createServer(); servers.push(server);
    const connected = once(server, 'connection'); server.listen(endpoint.path);
    const [socket] = await connected as [Socket]; sockets.push(socket); socket.on('error', () => {});
    return { endpoint, socket, accepted };
  }

  it('authenticates the host before accepting the native peer, preserving a coalesced binary tail', async () => {
    const { endpoint, socket, accepted } = await open();
    const answer = once(socket, 'data'); socket.write(`hello stdout ${nonce}\n`);
    expect(String((await answer)[0])).toBe(`auth ${proof(key, `host stdout ${nonce}`)}\n`);
    const bytes = Buffer.from([0, 255, 128, 10, 13, 65]);
    socket.write(Buffer.concat([Buffer.from(`ready ${proof(key, `supervisor stdout ${nonce}`)}\n`), bytes]));
    await endpoint.ready;
    expect(Buffer.concat(accepted)).toEqual(bytes);
  });

  it.each(['wrong-key', 'wrong-kind', 'wrong-nonce', 'non-ascii'])('refuses %s proof and sends no specification', async (variant) => {
    const { socket, accepted } = await open(); const received: Buffer[] = [];
    socket.on('data', (bytes) => received.push(Buffer.from(bytes)));
    const answer = once(socket, 'data'); socket.write(`hello stdout ${nonce}\n`); await answer;
    const ready = proof(variant === 'wrong-key' ? '33'.repeat(32) : key,
      `supervisor ${variant === 'wrong-kind' ? 'stdin' : 'stdout'} ${variant === 'wrong-nonce' ? '44'.repeat(32) : nonce}`);
    const ended = once(socket, 'close'); socket.write(`ready ${variant === 'non-ascii' ? 'é'.repeat(64) : ready}\n`); await ended;
    expect(accepted).toHaveLength(0);
    expect(Buffer.concat(received).toString()).not.toContain('private-specification');
  });

  it.each(['x'.repeat(193), 'hello stdin ' + nonce + '\n'])('bounds or refuses an invalid header without admitting it', async (header) => {
    const { socket, accepted } = await open(); const ended = once(socket, 'close'); socket.write(header); await ended;
    expect(accepted).toHaveLength(0);
  });

  it('does not extend the authentication deadline for a slow partial header', async () => {
    const { socket, accepted } = await open(150); const started = Date.now();
    const ended = once(socket, 'close');
    const timer = setInterval(() => socket.write('h'), 30);
    try { await ended; } finally { clearInterval(timer); }
    expect(Date.now() - started).toBeLessThan(750);
    expect(accepted).toHaveLength(0);
  });
});
