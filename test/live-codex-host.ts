import type { Readable, Writable } from 'node:stream';
import { serve } from '../src/acp/stdio.js';
import { CodexDriver } from '../src/codex/driver.js';
import {
  StdioCodexTransport,
  type CodexTransportOptions,
} from '../src/codex/transport.js';

export interface LiveCodexHostOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  readonly onSpawnEnvironment?: (environment: Readonly<Record<string, string>>) => void;
  readonly onProtocolError?: (sessionId: string, problem: string) => void;
}

/** Construct the real ACP host and Codex App Server transport for live tests. */
export function startLiveCodexHost(options: LiveCodexHostOptions) {
  const parentEnv = options.parentEnv ?? process.env;

  return serve({
    input: options.input,
    output: options.output,
    onProtocolError: options.onProtocolError,
    driverFactory: (session, events) =>
      new CodexDriver(
        {
          cwd: session.cwd,
          ...(session.resumeSessionId === undefined
            ? {}
            : { resumeSessionId: session.resumeSessionId }),
          parentEnv,
          allowEnv: ['CODEX_HOME'],
        },
        events,
        (transportOptions: CodexTransportOptions, handlers) => {
          options.onSpawnEnvironment?.(transportOptions.env);
          return new StdioCodexTransport(transportOptions, handlers);
        },
      ),
  });
}
