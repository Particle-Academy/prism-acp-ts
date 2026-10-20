import type { ChildProcess } from 'node:child_process';
import { NdjsonFramer, encodeLine } from '../ndjson.js';
import { launchProvider, type ProcessTree, type ProviderProcess, type StopOptions, type StopVerdict } from '../process-tree.js';

export interface CodexTransportHandlers {
  readonly onFrame: (frame: unknown) => void;
  readonly onStderr: (line: string) => void;
  readonly onProblem: (problem: string, detail?: import('../acp/agent.js').ProblemDetail) => void;
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface CodexTransport {
  start(): Promise<void>;
  send(frame: unknown): void;
  close(signal?: NodeJS.Signals): void;
  /** End app-server and its whole process tree, and say whether anything is left. */
  stop?(options?: StopOptions): Promise<StopVerdict>;
  readonly processTree?: ProcessTree | null;
}

export interface CodexTransportOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly binary?: string;
  /** Arguments placed before `app-server ...`, for a binary that is an interpreter (see CodexDriverOptions). */
  readonly binaryArgs?: readonly string[];
}

/** Run App Server over its measured, newline-framed stdio JSON-RPC channel. */
export class StdioCodexTransport implements CodexTransport {
  readonly #options: CodexTransportOptions;
  readonly #handlers: CodexTransportHandlers;
  readonly #framer = new NdjsonFramer();
  #child: ChildProcess | null = null;
  #provider: ProviderProcess | null = null;
  #stderrBuffer = '';
  #closed = false;
  #stderrOverflowReported = false;

  constructor(options: CodexTransportOptions, handlers: CodexTransportHandlers) {
    this.#options = options;
    this.#handlers = handlers;
  }

  async start(): Promise<void> {
    if (this.#child !== null) throw new Error('Codex transport already started');
    const major = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(major) || major < 22) {
      throw new Error('Codex app-server stdio transport requires Node.js 22 or newer');
    }

    // Under a supervisor that owns the whole process tree, and never through a shell (see process-tree.ts).
    const provider = launchProvider(this.#options.binary ?? 'codex', [...(this.#options.binaryArgs ?? []), 'app-server', '--listen', 'stdio://'], {
      cwd: this.#options.cwd,
      env: { ...this.#options.env },
    });
    this.#provider = provider;
    const child = provider.child;
    this.#child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const frame of this.#framer.push(chunk)) {
        if (frame.ok) this.#handlers.onFrame(frame.value);
        else this.#handlers.onProblem(frame.error.message, { recoverable: true });
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.#onStderr(chunk));
    child.on('error', (cause: Error) => this.#handlers.onProblem(`failed to spawn Codex (${cause.name})`));
    child.on('close', (code, signal) => {
      this.#closed = true;
      for (const frame of this.#framer.end()) {
        if (frame.ok) this.#handlers.onFrame(frame.value);
        else this.#handlers.onProblem(frame.error.message, { recoverable: true });
      }
      this.#handlers.onExit(code, signal);
    });

    await new Promise<void>((resolve, reject) => {
      provider.started.then(() => resolve(), (cause: Error) => reject(new Error(`Codex app-server spawn failed (${cause.name})`)));
      child.once('error', (cause: Error) => reject(new Error(`Codex app-server spawn failed (${cause.name})`)));
    });
  }

  send(frame: unknown): void {
    const stdin = this.#child?.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed || this.#closed) {
      throw new Error('Codex app-server stdin is not open');
    }
    stdin.write(encodeLine(frame));
  }

  close(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child?.stdin?.end();
    this.#provider?.kill(signal);
  }

  stop(options?: StopOptions): Promise<StopVerdict> {
    this.#closed = true;
    if (this.#provider === null) return Promise.resolve({ graceful: true, empty: true, survivors: 0, verified: true });
    return this.#provider.stop(options);
  }

  get processTree(): ProcessTree | null {
    return this.#provider?.tree ?? null;
  }

  #onStderr(chunk: string): void {
    this.#stderrBuffer += chunk;
    if (this.#stderrBuffer.length > 64_000) {
      if (!this.#stderrOverflowReported) {
        this.#stderrOverflowReported = true;
        this.#handlers.onProblem('Codex stderr buffer exceeded 64000 characters');
      }
      this.#stderrBuffer = this.#stderrBuffer.slice(-64_000);
    }
    let newline: number;
    while ((newline = this.#stderrBuffer.indexOf('\n')) !== -1) {
      const line = this.#stderrBuffer.slice(0, newline).replace(/\r$/, '');
      this.#stderrBuffer = this.#stderrBuffer.slice(newline + 1);
      if (line.length > 0) {
        // App Server stderr is not a public logging surface: provider output
        // can contain account and rate-limit identifiers.
        this.#handlers.onStderr(`Codex stderr line withheld (${line.length} characters)`);
      }
    }
  }
}
