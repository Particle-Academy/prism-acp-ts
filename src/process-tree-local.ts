import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { Socket } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ProcessTreeError, type LaunchOptions, type ProcessTree, type ProviderProcess, type StopOptions, type StopVerdict } from './process-tree.js';

const PIPE_PREFIX = '\\\\.\\pipe\\LOCAL\\prism-acp-';
const BUFFER_BYTES = 65_536;
const DRAIN_MS = 5_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
const mac = (token: string, text: string) => createHmac('sha256', token).update(text).digest('hex');
const same = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Connect only to the supervisor's ACL-restricted endpoint; authenticate before delivering any raw bytes. */
export class LocalPipe {
  readonly path = PIPE_PREFIX + randomBytes(24).toString('hex');
  readonly ready: Promise<Socket>;
  #socket: Socket | null = null;
  #timer: ReturnType<typeof setTimeout>;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #reject!: (error: Error) => void;
  #closed = false;

  constructor(kind: string, token: string, timeout: number, accepted: (socket: Socket, remainder: Buffer) => void, failed: () => void) {
    let resolve!: (socket: Socket) => void;
    this.ready = new Promise<Socket>((yes, no) => { resolve = yes; this.#reject = no; });
    this.ready.catch(() => {});
    const fail = () => { this.close(); failed(); };
    this.#timer = setTimeout(fail, timeout).unref();
    const connect = () => {
      if (this.#closed) return;
      const socketOptions = { allowHalfOpen: true, readableHighWaterMark: BUFFER_BYTES, writableHighWaterMark: BUFFER_BYTES };
      const socket = new Socket(socketOptions);
      socket.connect(this.path);
      this.#socket = socket;
      let connected = false, authenticated = false;
      let buffer = Buffer.alloc(0), nonce: string | null = null;
      socket.once('connect', () => { connected = true; });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (this.#closed) return;
        if (!connected && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) {
          this.#retry = setTimeout(connect, 10).unref();
        } else fail();
      });
      socket.once('end', () => { if (!authenticated && !this.#closed) fail(); });
      const read = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const newline = buffer.indexOf(10);
          if (newline < 0) { if (buffer.length > 192) fail(); return; }
          if (newline > 192) { fail(); return; }
          const line = buffer.subarray(0, newline).toString('utf8');
          buffer = buffer.subarray(newline + 1);
          if (nonce === null) {
            const prefix = `hello ${kind} `;
            if (!line.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(line.slice(prefix.length))) { fail(); return; }
            nonce = line.slice(prefix.length);
            socket.write(`auth ${mac(token, `host ${kind} ${nonce}`)}\n`);
          } else {
            if (this.#closed) { socket.destroy(); return; }
            if (!same(line, `ready ${mac(token, `supervisor ${kind} ${nonce}`)}`)) { fail(); return; }
            authenticated = true;
            clearTimeout(this.#timer);
            socket.removeListener('data', read);
            socket.pause();
            this.#socket = socket;
            accepted(socket, buffer);
            resolve(socket);
            return;
          }
        }
      };
      socket.on('data', read);
    };
    connect();
  }

  stopListening(): void { clearTimeout(this.#retry); }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.stopListening();
    this.#socket?.destroy();
    this.#reject(new ProcessTreeError('local pipe closed before authentication'));
  }
}

/** AppContainer-compatible launch: no libuv-created stdio pipes or loopback sockets. */
export function launchWindowsLocal(supervisor: string, spec: string, options: LaunchOptions, timeout: number): ProviderProcess {
  return new LocalProvider(supervisor, spec, options, timeout);
}

class LocalProvider implements ProviderProcess {
  readonly child: ChildProcess;
  readonly io: { readonly stdin: Writable; readonly stdout: PassThrough; readonly stderr: PassThrough };
  readonly started: Promise<ProcessTree>;
  readonly closed: Promise<void>;
  #pipes: LocalPipe[] = [];
  #control: Socket | null = null;
  #tree: ProcessTree | null = null;
  #failed = false;
  #gone = false;
  #exited = false;
  #emptyCount: number | null = null;
  #resolveStart!: (tree: ProcessTree) => void;
  #rejectStart!: (error: Error) => void;
  #resolveGone!: () => void;
  #gonePromise: Promise<void>;
  #resolveExit!: () => void;
  #exitPromise: Promise<void>;
  #resolveEmpty!: (count: number) => void;
  #emptyPromise: Promise<number>;
  #deadline: ReturnType<typeof setTimeout>;
  #verdict: Promise<StopVerdict> | null = null;

  constructor(supervisor: string, spec: string, options: LaunchOptions, timeout: number) {
    const ioTimeout = options.ioTimeoutMs ?? 30_000;
    let input: Promise<Socket>;
    this.io = {
      stdin: new Writable({ highWaterMark: BUFFER_BYTES,
        write: (chunk: Buffer, _encoding, callback) => {
          let done = false;
          const finish = (error?: Error | null) => { if (done) return; done = true; clearTimeout(timer); callback(error); };
          const timer = setTimeout(() => { this.#fail('stdin write deadline exceeded'); finish(new ProcessTreeError('stdin write deadline exceeded')); }, ioTimeout).unref();
          input.then(socket => { if (!done) socket.write(chunk, finish); }, finish);
        },
        final: callback => { input.then(socket => { socket.end(); callback(); }, callback); },
      }),
      stdout: new PassThrough({ highWaterMark: BUFFER_BYTES }), stderr: new PassThrough({ highWaterMark: BUFFER_BYTES }),
    };
    for (const stream of Object.values(this.io)) stream.on('error', () => {});
    this.started = new Promise((yes, no) => { this.#resolveStart = yes; this.#rejectStart = no; });
    this.started.catch(() => {});
    this.#gonePromise = new Promise((yes) => { this.#resolveGone = yes; });
    this.#exitPromise = new Promise((yes) => { this.#resolveExit = yes; });
    this.#emptyPromise = new Promise((yes) => { this.#resolveEmpty = yes; });
    const token = randomBytes(32).toString('hex');
    this.#deadline = setTimeout(() => this.#fail('startup deadline exceeded'), timeout).unref();
    const failed = () => this.#fail('local pipe failed');
    const control = new LocalPipe('control', token, timeout, (socket, remainder) => {
      this.#control = socket;
      let buffer = Buffer.alloc(0);
      const read = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 4096) { this.#fail('control frame too large'); return; }
        let newline: number;
        while ((newline = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, newline).toString('ascii');
          buffer = buffer.subarray(newline + 1);
          this.#line(line);
        }
      };
      socket.on('data', read);
      socket.once('end', () => { if (!this.#gone && this.#emptyCount === null) this.#fail('control ended without a tree verdict'); });
      if (remainder.length !== 0) read(remainder);
      socket.write(spec + '\n');
      socket.resume();
    }, failed);
    this.#pipes.push(control);
    for (const kind of ['stdin', 'stdout', 'stderr'] as const) {
      const pipe = new LocalPipe(kind, token, timeout, (socket, remainder) => {
        if (kind === 'stdin') {
          if (remainder.length !== 0) { this.#fail('unexpected stdin channel bytes'); return; }
        } else {
          const output = this.io[kind];
          if (remainder.length !== 0) socket.unshift(remainder);
          socket.pipe(output);
          let blocked: ReturnType<typeof setTimeout> | undefined;
          const clear = () => { clearTimeout(blocked); blocked = undefined; };
          output.on('drain', clear);
          output.once('close', clear);
          // Check after pipe() has written this chunk. Idle sessions have no deadline.
          socket.on('data', () => {
            if (output.writableNeedDrain && blocked === undefined) blocked = setTimeout(() => this.#fail('output drain deadline exceeded'), ioTimeout).unref();
          });
        }
      }, failed);
      this.#pipes.push(pipe);
      if (kind === 'stdin') input = pipe.ready;
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env)) {
      if (value !== undefined && !/^PRISM_ACP_TREE_(?:CHANNEL|TOKEN|IO_\d)$/i.test(name)) env[name] = value;
    }
    env.PRISM_ACP_TREE_CHANNEL = control.path;
    env.PRISM_ACP_TREE_TOKEN = token;
    for (let i = 0; i < 3; i++) env[`PRISM_ACP_TREE_IO_${i}`] = this.#pipes[i + 1].path;
    let bootstrap: number | undefined;
    try {
      // Neither anonymous pipes nor NUL are universally available to restricted
      // tokens. Reuse an already-readable trusted file, opened READ ONLY, for
      // unused bootstrap handles. No host input/output or writable file is exposed.
      // The supervisor must never use Console streams: diagnostics go through
      // authenticated control or a bounded exit-code/startup-failure report.
      bootstrap = openSync(supervisor, 'r');
      this.child = spawn(supervisor, [], { cwd: options.cwd, env, stdio: [bootstrap, bootstrap, bootstrap], windowsHide: true });
    } catch (error) {
      clearTimeout(this.#deadline);
      this.#cleanup();
      const code = (error as NodeJS.ErrnoException)?.code;
      throw new ProcessTreeError(`local supervisor could not be spawned (${typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'UNKNOWN'})`);
    } finally {
      if (bootstrap !== undefined) closeSync(bootstrap);
    }
    this.child.once('error', () => this.#fail('supervisor spawn failed'));
    this.child.once('close', () => {
      this.#gone = true;
      clearTimeout(this.#deadline);
      if (this.#tree === null) this.#fail(`supervisor ended before provider startup (exit ${this.child.exitCode ?? 'unknown'})`);
      this.#resolveGone();
      for (const pipe of this.#pipes) pipe.stopListening();
    });
    this.closed = this.#gonePromise.then(async () => {
      this.io.stdin.destroy();
      for (const output of [this.io.stdout, this.io.stderr]) if (output.listenerCount('data') === 0 && output.listenerCount('readable') === 0) output.resume();
      await Promise.race([
        Promise.all([finished(this.io.stdout, { writable: false }), finished(this.io.stderr, { writable: false })]).catch(() => {}),
        delay(DRAIN_MS),
      ]);
      this.#cleanup();
    });
  }

  get tree(): ProcessTree | null { return this.#tree; }

  #line(line: string): void {
    const match = /^(started|exited|empty) (\d{1,10})$/.exec(line);
    if (match === null) {
      const failure = /^failed ([\w-]{1,40})$/.exec(line);
      this.#fail(failure === null ? 'invalid control frame' : `native launch failed: ${failure[1]}`);
      return;
    }
    const value = Number(match[2]);
    if (value > 0xffff_ffff) { this.#fail('invalid control count'); return; }
    if (match[1] === 'started') {
      if (value === 0 || this.#tree !== null) { this.#fail('invalid provider identity'); return; }
      Promise.all(this.#pipes.map((pipe) => pipe.ready)).then(() => {
        if (this.#failed) return;
        this.#tree = { providerPid: value, supervisorPid: this.child.pid ?? 0, containment: { kind: 'job-object' } };
        clearTimeout(this.#deadline);
        this.#resolveStart(this.#tree);
      }, () => this.#fail('stdio handshake failed'));
    } else if (match[1] === 'exited') { this.#exited = true; this.#resolveExit(); }
    else { this.#emptyCount = value; this.#resolveEmpty(value); }
  }

  #fail(reason: string): void {
    if (this.#failed) return;
    this.#failed = true;
    clearTimeout(this.#deadline);
    const error = new ProcessTreeError(`failed to start the provider (${reason})`);
    this.#rejectStart(error);
    this.#control?.destroy();
    this.child?.kill();
    this.#cleanup();
  }

  kill(): void {
    if (this.#control !== null && !this.#control.destroyed) this.#control.write('kill\n');
    else this.child.kill();
  }

  stop(options: StopOptions = {}): Promise<StopVerdict> {
    this.#verdict ??= this.#stop(options.graceMs ?? 5000);
    return this.#verdict;
  }

  async #stop(grace: number): Promise<StopVerdict> {
    this.io.stdin.end();
    const graceful = this.#exited || await Promise.race([this.#exitPromise.then(() => true), this.#gonePromise.then(() => false), delay(grace).then(() => false)]);
    if (!this.#exited) this.kill();
    const count = await Promise.race([this.#emptyPromise, this.#gonePromise.then(() => this.#emptyCount), delay(10_000).then(() => null)]);
    if (count === null && !this.#gone) this.child.kill();
    await Promise.race([this.#gonePromise, delay(10_000)]);
    await Promise.race([this.closed, delay(DRAIN_MS)]);
    return { graceful, empty: count === 0 || (count === null && this.#gone), survivors: count, verified: count !== null };
  }

  #cleanup(): void {
    for (const pipe of this.#pipes) pipe.close();
    for (const stream of Object.values(this.io)) stream.destroy();
  }
}
