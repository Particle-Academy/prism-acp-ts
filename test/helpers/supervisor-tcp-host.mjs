// Test host for the shared Windows supervisor protocol. Also runs in a separate process for host-death tests.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
export async function until(read, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  do {
    const result = read();
    if (result !== undefined) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${label}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export class TcpHost {
  constructor() {
    this.token = randomBytes(32).toString('hex');
    this.sockets = new Set();
    this.io = [];
    this.lines = [];
    this.stdout = [];
    this.stderr = [];
    this.received = new Map();
    this.headers = new Map();
    this.child = null;
    this.control = null;
    this.closed = deferred();
    this.hello = deferred();
    this.started = deferred();
    this.empty = deferred();
    this.ioReady = [deferred(), deferred(), deferred()];
    this.ioEnded = [deferred(), deferred(), deferred()];
  }

  static async open(executable, options = {}) {
    const host = new TcpHost();
    host.options = options;
    host.server = createServer((socket) => host.accept(socket));
    await new Promise((resolve, reject) => {
      host.server.once('error', reject);
      host.server.listen(0, '127.0.0.1', resolve);
    });
    const channel = `tcp://127.0.0.1:${host.server.address().port}`;
    host.child = spawn(executable, [], {
      cwd: options.cwd,
      env: { ...process.env, PRISM_ACP_TREE_CHANNEL: channel, PRISM_ACP_TREE_TOKEN: host.token },
      // Do not assign the supervisor to this host's libuv job. Control EOF must end the provider's Job Object.
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    host.child.once('error', (e) => { host.hello.reject(e); host.closed.reject(e); });
    host.child.once('close', (code) => {
      host.closed.resolve(code);
      const error = new Error(`supervisor ended before TCP handshake/start (${code})`);
      host.hello.reject(error); host.started.reject(error);
      for (const pending of host.ioReady) pending.reject(error);
    });
    return host;
  }

  accept(socket) {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => this.sockets.delete(socket));
    const deadline = setTimeout(() => socket.destroy(), 5_000);
    let header = Buffer.alloc(0);
    const onData = (chunk) => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 128) { socket.destroy(); return; }
      const newline = header.indexOf(10);
      if (newline < 0) return;
      const line = header.subarray(0, newline).toString('ascii');
      const rest = header.subarray(newline + 1);
      socket.removeListener('data', onData);
      clearTimeout(deadline);
      const hello = `hello ${this.token}`;
      if (equal(Buffer.from(line), Buffer.from(hello)) && this.control === null) {
        this.control = socket;
        this.headers.set('control', line);
        let text = rest.toString('ascii');
        socket.on('data', (data) => { text += data.toString('ascii'); consume(); });
        const consume = () => {
          let at;
          while ((at = text.indexOf('\n')) !== -1) {
            const value = text.slice(0, at).replace(/\r$/, ''); text = text.slice(at + 1);
            this.lines.push(value);
            if (/^started \d+$/.test(value)) this.started.resolve(Number(value.slice(8)));
            if (/^empty \d+$/.test(value)) this.empty.resolve(Number(value.slice(6)));
          }
        };
        consume();
        this.hello.resolve();
        if (this.options.controlAuth !== false) {
          socket.write(`auth ${this.options.controlAuth ?? this.token}\n`);
        }
        return;
      }
      const match = /^stdio ([0-9a-f]{64}) ([012])$/.exec(line);
      if (match === null || !equal(Buffer.from(match[1]), Buffer.from(this.token))) { socket.destroy(); return; }
      const fd = Number(match[2]);
      if (this.io[fd] !== undefined) { socket.destroy(); return; }
      this.io[fd] = socket;
      this.headers.set(fd, line);
      socket.on('end', () => this.ioEnded[fd].resolve());
      if (fd !== 0) {
        const output = fd === 1 ? this.stdout : this.stderr;
        if (rest.length) output.push(rest);
        socket.on('data', (data) => output.push(data));
        if (this.options.pauseOutputs) socket.pause();
      }
      const auth = this.options.stdioAuth?.[fd] ?? this.token;
      if (auth !== false) {
        const ack = Buffer.from(`auth ${auth} ${this.options.stdioRole?.[fd] ?? fd}\n`);
        // Send the first raw input bytes with the ACK to catch a line reader that consumes bytes beyond its header.
        socket.write(fd === 0 ? Buffer.concat([ack, this.options.initialStdin ?? Buffer.alloc(0)]) : ack);
      }
      this.ioReady[fd].resolve();
    };
    socket.on('data', onData);
    socket.once('close', () => clearTimeout(deadline));
  }

  async sendSpec(spec) {
    await this.hello.promise;
    this.control.write(Buffer.isBuffer(spec) ? spec : `${spec}\n`);
  }

  async launch(spec) {
    await this.sendSpec(spec);
    return this.started.promise;
  }

  async stop() {
    this.control?.write('kill\n');
    const count = await this.empty.promise;
    await this.closed.promise;
    return count;
  }

  async dispose() {
    if (this.child?.exitCode === null) this.control?.write('kill\n');
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    if (this.child && this.child.exitCode === null) {
      await Promise.race([this.closed.promise, delay(2_000)]);
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
      await Promise.race([this.closed.promise, delay(2_000)]);
    }
  }
}

if (process.argv[2] === '--host' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let host;
  try {
    host = await TcpHost.open(process.argv[3], { cwd: process.argv[4] });
    const providerPid = await host.launch(Buffer.from(process.argv[5], 'base64').toString('utf8'));
    console.log(JSON.stringify({ hostPid: process.pid, supervisorPid: host.child.pid, providerPid }));
  } catch (e) {
    console.error(e.message);
    await host?.dispose();
    process.exitCode = 1;
  }
}
