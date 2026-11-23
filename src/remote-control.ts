/**
 * Remote control is forced off for every CLI this package launches (G-319, owner directive: "remote chat needs to be
 * forced off"). There is no option that turns it back on.
 *
 * Claude Code: the documented switch is the `disableRemoteControl` settings key. Per
 * https://code.claude.com/docs/en/settings-reference#disableremotecontrol it makes Claude Code refuse `claude
 * remote-control`, the `--remote-control` flag, auto-start and the in-session toggle. Delivered with `--settings`, it
 * sits above every user, project and local file and below managed settings
 * (https://code.claude.com/docs/en/settings), so the person's own files cannot turn it back on and nothing is written
 * to them. A managed (admin) `false` still outranks it: documented precedence, no exception listed.
 *
 * Codex: there is no documented per-launch switch, only the admin `allow_remote_control = false` requirements key.
 * Codex is off BY CONSTRUCTION here: the launch is `app-server --listen stdio://`, never a remote-control flag or
 * subcommand, and {@link assertNotRemoteControlFrame} refuses any `remoteControl/*` RPC before it is written.
 */

/** The settings every Claude launch carries. Applied LAST, so no other settings value can replace it. */
export const CLAUDE_FORCED_SETTINGS: Readonly<{ disableRemoteControl: true }> = Object.freeze({ disableRemoteControl: true });

/** Merge the forced keys into settings a launch already passes. The host's other keys are kept; ours win. */
export function claudeLaunchSettings<T extends Record<string, unknown>>(settings: T): T & { disableRemoteControl: true } {
  return { ...settings, ...CLAUDE_FORCED_SETTINGS };
}

/** The inline `--settings` value for a launch that has no settings file of its own. */
export function claudeForcedSettingsJson(): string {
  return JSON.stringify(CLAUDE_FORCED_SETTINGS);
}

/**
 * The environment the opt-in `disableFeatureFlags` host option adds (ClaudeDriverOptions, ListModelsOptions).
 * `CLAUDE_CODE_DISABLE_FEATURE_FLAGS` needs Claude Code 2.1.319 or later; `DISABLE_GROWTHBOOK` is the older name, the
 * only one 2.1.124 through 2.1.318 read (https://code.claude.com/docs/en/env-vars).
 */
export function claudeFeatureFlagEnv(disable: unknown): Record<string, string> {
  if (disable === undefined || disable === false) return {};
  if (disable !== true) throw new Error('disableFeatureFlags must be a boolean');
  return { CLAUDE_CODE_DISABLE_FEATURE_FLAGS: '1', DISABLE_GROWTHBOOK: '1' };
}

export class RemoteControlRefused extends Error {
  readonly code = 'remote_control_refused' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RemoteControlRefused';
  }
}

// Whitespace and invisible format characters a token could be padded with. Spelled out rather than trusting \s, which
// does not cover the zero-width characters.
const PADDING = /[\s\u00ad\u180e\u200b-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/gu;

function normalised(token: string): string {
  return token.replace(PADDING, '').toLowerCase();
}

// Argv tokens that start or carry remote/cloud continuation, or that would put a second --settings ahead of ours.
const CLAUDE_REFUSED = ['--remote-control', '--remote-control-session-name-prefix', 'remote-control', '--rc', '--cloud', '--remote', '--teleport', '--settings'];
const CODEX_REFUSED = ['--remote-control', 'remote-control', 'enable-remote-control', 'daemon', '--remote', 'cloud'];

/**
 * Refuse host-supplied argv (`binaryArgs`) that would start remote control, or (Claude) replace the forced settings.
 * Checked before anything is written or spawned.
 */
export function assertNoRemoteControlArgs(provider: 'claude' | 'codex', args: readonly string[] | undefined): void {
  if (args === undefined) return;
  const refused = provider === 'claude' ? CLAUDE_REFUSED : CODEX_REFUSED;
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    const token = normalised(arg).split('=')[0]!;
    if (refused.includes(token)) {
      throw new RemoteControlRefused(`binaryArgs may not carry ${token}: remote control is forced off for ${provider} launches`);
    }
  }
}

/**
 * The line to write for a Codex frame. It is serialized once and that serialized form is what gets checked, so a
 * `toJSON` or an accessor cannot show the check one value and the wire another.
 *
 * A frame is one JSON-RPC object. A list is refused outright: nothing in the driver sends one. Replies (no `method`)
 * pass.
 */
export function encodeCodexFrame(frame: unknown): string {
  const text = JSON.stringify(frame);
  if (text === undefined) throw new RemoteControlRefused('frame could not be serialized');
  const written: unknown = JSON.parse(text);
  if (Array.isArray(written)) throw new RemoteControlRefused('list frames are refused: a Codex frame is one JSON-RPC object');
  if (typeof written === 'object' && written !== null) {
    const method = (written as { method?: unknown }).method;
    if (typeof method === 'string') {
      const name = normalised(method);
      if (name === 'remotecontrol' || name.startsWith('remotecontrol/')) {
        throw new RemoteControlRefused('remoteControl RPCs are refused: remote control is forced off for codex launches');
      }
    }
  }
  return `${text}\n`;
}

/** Refuse a frame {@link encodeCodexFrame} would refuse. Throws before anything is written. */
export function assertNotRemoteControlFrame(frame: unknown): void {
  encodeCodexFrame(frame);
}
