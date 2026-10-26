/**
 * MCP server status, in one shape for every driver (genie#1202).
 *
 * A host gives a session MCP servers and needs to know whether their tools
 * actually arrived. Both agents can come up with a server that is unusable:
 *
 * - Claude Code reports a server whose `tools/list` FAILED after a clean
 *   `initialize` as `connected`, with no tools (measured on CLI 2.1.310: an
 *   MCP server answering initialize and then erroring on tools/list appears in
 *   system/init as `{ status: 'connected' }` with zero `mcp__<name>__*` tools).
 *   So `status` alone cannot detect it; `toolCount: 0` does.
 * - Codex reports the same server as `failed`, with the error, after one retry
 *   (measured on codex-cli 0.163.0, `mcpServer/startupStatus/updated`).
 *
 * `toolCount` is null where the source does not say (Codex startup updates).
 * `raw` keeps the agent's own word when it differs from the normalised one.
 */
export type McpServerState = 'connected' | 'pending' | 'failed' | 'needs-auth' | 'disabled';

export interface McpServerReport {
  readonly name: string;
  readonly status: McpServerState;
  /** Tools the agent can actually call from this server; null when the source does not report tools. */
  readonly toolCount: number | null;
  /** The agent's own status value, when it is not the normalised one. */
  readonly raw?: string;
  /** The agent's error text, when it gave one. */
  readonly error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function report(name: string, status: McpServerState, raw: string, toolCount: number | null, error?: unknown): McpServerReport {
  return {
    name,
    status,
    toolCount,
    ...(raw === status ? {} : { raw }),
    ...(typeof error === 'string' && error.length > 0 ? { error } : {}),
  };
}

const CLAUDE_STATES: Readonly<Record<string, McpServerState>> = {
  connected: 'connected',
  pending: 'pending',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  disabled: 'disabled',
};

/**
 * Claude Code's system/init `mcp_servers` (documented: `{ name, status, source? }[]`, status one of
 * connected | failed | needs-auth | pending | disabled), with each server's tool count taken from init's
 * `tools` by the `mcp__<name>__` prefix. An unknown status is reported as `failed` with its raw value: a host
 * must not read a value it does not understand as "connected". Undefined when init carries no `mcp_servers`.
 */
export function claudeMcpServers(init: Record<string, unknown>): McpServerReport[] | undefined {
  if (!Array.isArray(init.mcp_servers)) return undefined;
  const tools = Array.isArray(init.tools) ? init.tools.filter((tool): tool is string => typeof tool === 'string') : [];

  return init.mcp_servers.filter(isObject).flatMap((server) => {
    const name = typeof server.name === 'string' ? server.name : undefined;
    if (name === undefined || name.length === 0) return [];
    const raw = typeof server.status === 'string' ? server.status : 'unknown';
    const prefix = `mcp__${name}__`;

    return [report(name, CLAUDE_STATES[raw] ?? 'failed', raw, tools.filter((tool) => tool.startsWith(prefix)).length)];
  });
}

/**
 * One Codex `mcpServer/startupStatus/updated` notification (`status`: starting | ready | failed | cancelled,
 * `failureReason`: reauthenticationRequired). It carries no tool list, so `toolCount` is null.
 */
export function codexStartupReport(params: Record<string, unknown>): McpServerReport | undefined {
  const name = typeof params.name === 'string' ? params.name : undefined;
  if (name === undefined || name.length === 0) return undefined;
  const raw = typeof params.status === 'string' ? params.status : 'unknown';

  const status: McpServerState = params.failureReason === 'reauthenticationRequired'
    ? 'needs-auth'
    : raw === 'ready' ? 'connected' : raw === 'starting' ? 'pending' : 'failed';

  return report(name, status, raw, null, params.error);
}

/**
 * One entry of Codex `mcpServerStatus/list` for a thread (`runtimeStatus`: notStarted | starting | connected |
 * authenticationRequired | failed | cancelled | disabled, or null when unavailable), with its tool count.
 */
export function codexListedReport(entry: Record<string, unknown>): McpServerReport | undefined {
  const name = typeof entry.name === 'string' ? entry.name : undefined;
  if (name === undefined || name.length === 0) return undefined;
  const raw = typeof entry.runtimeStatus === 'string' ? entry.runtimeStatus : 'unavailable';

  const status: McpServerState = raw === 'connected' ? 'connected'
    : raw === 'notStarted' || raw === 'starting' ? 'pending'
      : raw === 'authenticationRequired' ? 'needs-auth'
        : raw === 'disabled' ? 'disabled'
          : 'failed';
  const tools = entry.tools;
  const toolCount = Array.isArray(tools) ? tools.length : isObject(tools) ? Object.keys(tools).length : null;

  return report(name, status, raw, toolCount);
}
