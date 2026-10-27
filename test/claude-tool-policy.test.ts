import { describe, expect, it } from 'vitest';
import { ClaudeDriver, claudeArgs, type ClaudeDriverOptions } from '../src/claude/driver.js';

// The new policy is trusted embedder configuration, never a model/ACP argument.
type RestrictedOptions = ClaudeDriverOptions & { nativeTools: 'none' };
const restricted = (extra: Partial<ClaudeDriverOptions> = {}): RestrictedOptions => ({ cwd: '.', ...extra, nativeTools: 'none' });

describe('Claude app MCP only policy', () => {
  it('removes built-in capabilities and inherited settings/MCP using explicit CLI controls', () => {
    const args = claudeArgs(restricted(), '/owned/private/mcp.json');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', '']);
    expect(args).toContain('--restricted');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
  });

  it('accepts supplied MCP under LOCAL without enabling permission hooks', () => {
    expect(() => new ClaudeDriver(restricted({
      processTree: { windowsStdio: 'local-pipes' },
      mcpServers: [{ type: 'http', name: 'owned', url: 'http://127.0.0.1:1/mcp', headers: [] }],
    }))).not.toThrow();
  });

  it('refuses an unknown policy rather than ignoring it', () => {
    expect(() => claudeArgs({ cwd: '.', nativeTools: 'all' } as unknown as ClaudeDriverOptions)).toThrow(/nativeTools/);
  });

  it('refuses bypassed permissions and unmeasured prior-session state', () => {
    expect(() => new ClaudeDriver(restricted({ permissionMode: 'bypassPermissions' }))).toThrow('bypassPermissions');
    expect(() => new ClaudeDriver(restricted({ resumeSessionId: 'owned-session' }))).toThrow('fresh Claude session');
  });

  it('keeps the default driver argument vector unchanged', () => {
    expect(claudeArgs({ cwd: '.' })).toEqual([
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--verbose', '--include-partial-messages',
    ]);
  });
});
