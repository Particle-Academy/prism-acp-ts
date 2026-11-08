/** Native operations measured on the released App Server CLI, not a discovered TUI command catalog. */
export type CodexCommand = 'compact' | 'review';
export type CommandRefusal = 'unknown_command' | 'invalid_arguments' | 'not_ready' | 'session_closed'
  | 'busy' | 'unmeasured_cli' | 'native_tools_restricted' | 'native_method_missing' | 'native_refused';

export class CommandUnsupported extends Error {
  override readonly name = 'CommandUnsupported';
  readonly code = 'command_unsupported';
  constructor(readonly reason: CommandRefusal) { super('command_unsupported: ' + reason); }
}

export function codexCommand(name: unknown): CodexCommand {
  if (name !== 'compact' && name !== 'review') throw new CommandUnsupported('unknown_command');
  return name;
}

export function commandsMeasured(version: string | null): boolean { return version === '0.167.0'; }
