import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeToAcp, type AcpUpdate } from '../src/claude/to-acp.js';
import { META_CLI_SESSION_ID, META_COMMAND_SOURCE, META_PLUGINS, META_SUBAGENTS } from '../src/meta.js';

/**
 * Claude's init frame lists what the agent can be asked to run: its slash commands and its skills,
 * plus the plugins and subagents they come from. A client builds its `/` menu from
 * `available_commands_update`, so the init frame has to produce one. It used to be read only for
 * its session id, and every command and skill on it was dropped.
 *
 * The first frame of the real capture is used, not a hand-written one.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/claude-tool-turn.ndjson', import.meta.url));
const init = JSON.parse(readFileSync(FIXTURE, 'utf8').split('\n')[0]!) as Record<string, unknown>;

function commandsUpdate(frame: Record<string, unknown>): AcpUpdate | undefined {
  return new ClaudeToAcp().frame(frame).find((u) => u.sessionUpdate === 'available_commands_update');
}

type Cmd = { name: string; description: string; _meta?: Record<string, unknown> };

describe('system/init lists the agent’s commands', () => {
  it('maps every slash command and every skill, names without the slash, and nothing else', () => {
    const update = commandsUpdate(init);
    expect(update).toBeDefined();
    const cmds = (update as unknown as { availableCommands: Cmd[] }).availableCommands;
    const terminalOnly = init['terminal_slash_commands'] as string[];
    const skills = (init['skills'] as string[]).filter((s) => !terminalOnly.includes(s));
    const slash = (init['slash_commands'] as string[]).map((c) => c.replace(/^\//, ''));
    // COUNTED: exactly the slash commands plus the skills no terminal-only command shadows.
    expect(cmds).toHaveLength(slash.length + skills.length);
    expect(cmds.map((c) => c.name)).toEqual([...slash, ...skills]);
    expect(cmds.every((c) => !c.name.startsWith('/'))).toBe(true);
    // Terminal-only commands are not offered: they do nothing outside the interactive TUI.
    expect(cmds.filter((c) => terminalOnly.includes(c.name))).toHaveLength(0);
  });

  it('says where each one comes from: a command or a skill', () => {
    const cmds = (commandsUpdate(init) as unknown as { availableCommands: Cmd[] }).availableCommands;
    const source = (c: Cmd) => c._meta?.[META_COMMAND_SOURCE];
    const terminalOnly = init['terminal_slash_commands'] as string[];
    expect(cmds.filter((c) => source(c) === 'skill')).toHaveLength((init['skills'] as string[]).filter((s) => !terminalOnly.includes(s)).length);
    expect(cmds.filter((c) => source(c) === 'command')).toHaveLength((init['slash_commands'] as string[]).length);
    expect(cmds.find((c) => c.name === 'help')?.description).toBe('Command');
    expect(cmds.find((c) => c.name === 'genie')?.description).toBe('Skill');
  });

  it('carries the plugins (name, source, version; never the local path) and the subagents', () => {
    const meta = commandsUpdate(init)?._meta as Record<string, unknown>;
    const plugins = meta[META_PLUGINS] as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength((init['plugins'] as unknown[]).length);
    expect(plugins.find((p) => p['name'] === 'code-simplifier')).toEqual({
      name: 'code-simplifier',
      source: 'code-simplifier@claude-plugins-official',
      version: '1.0.0',
    });
    expect(plugins.filter((p) => 'path' in p)).toHaveLength(0);
    expect(meta[META_SUBAGENTS]).toEqual(init['agents']);
  });

  it('comes right after the session-id notice, so the id is still the first update', () => {
    const updates = new ClaudeToAcp().frame(init);
    expect((updates[0]?._meta as Record<string, unknown>)[META_CLI_SESSION_ID]).toBeDefined();
    expect(updates.map((u) => u.sessionUpdate)).toEqual(['notice', 'available_commands_update']);
  });

  it('an init that lists none reports none ([]); one that carries no lists claims nothing', () => {
    const empty = commandsUpdate({ type: 'system', subtype: 'init', session_id: 's', slash_commands: [], skills: [] });
    expect((empty as unknown as { availableCommands: Cmd[] }).availableCommands).toEqual([]);
    expect(commandsUpdate({ type: 'system', subtype: 'init', session_id: 's' })).toBeUndefined();
  });

  it('a skill that shares its name with a terminal-only command is not offered (which one runs is not documented)', () => {
    // The real capture has exactly this: a `doctor` skill and the terminal-only `/doctor`.
    expect((init['skills'] as string[])).toContain('doctor');
    expect((init['terminal_slash_commands'] as string[])).toContain('doctor');
    const update = commandsUpdate({ type: 'system', subtype: 'init', session_id: 's', slash_commands: [], skills: ['doctor', 'genie'], terminal_slash_commands: ['doctor'] });
    expect((update as unknown as { availableCommands: Cmd[] }).availableCommands.map((c) => c.name)).toEqual(['genie']);
  });

  it('a name listed as both a command and a skill is offered once', () => {
    const update = commandsUpdate({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['/review'], skills: ['review'] });
    expect((update as unknown as { availableCommands: Cmd[] }).availableCommands.map((c) => c.name)).toEqual(['review']);
  });
});
