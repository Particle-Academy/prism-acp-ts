import { RpcError, RPC_INVALID_PARAMS } from './jsonrpc.js';

/** ACP session MCP configuration. The client supplies explicit credentials here. */
export interface McpNamedValue { readonly name: string; readonly value: string }
export type McpServer =
  | { readonly type?: 'stdio'; readonly name: string; readonly command: string;
      readonly args: readonly string[]; readonly env: readonly McpNamedValue[] }
  | { readonly type: 'http' | 'sse'; readonly name: string; readonly url: string;
      readonly headers: readonly McpNamedValue[] };

export interface McpCapabilities { readonly http: boolean; readonly sse: boolean }

/** Validate the entire list before starting any child; never drop a bad entry. */
export function readMcpServers(value: unknown): readonly McpServer[] {
  // Preserve the existing session API for callers that omitted the field.
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('must be an array');
  const names = new Set<string>();
  return value.map((entry: unknown, index: number): McpServer => {
    const server = object(entry);
    const prefix = `entry ${index}`;
    if (server === undefined) invalid(`${prefix} must be an object`);
    const name = text(server.name, `${prefix}.name`, false);
    if (names.has(name)) invalid(`${prefix} has a duplicate server name`);
    names.add(name);
    if (server.type === 'http' || server.type === 'sse') {
      const url = text(server.url, `${prefix}.url`, false);
      try {
        if (!['http:', 'https:'].includes(new URL(url).protocol)) invalid(`${prefix}.url must use HTTP or HTTPS`);
      } catch { invalid(`${prefix}.url must be an absolute HTTP or HTTPS URL`); }
      return { type: server.type, name, url, headers: pairs(server.headers, `${prefix}.headers`, true) };
    }
    if (server.type !== undefined && server.type !== 'stdio') invalid(`${prefix} has an unsupported transport`);
    const command = text(server.command, `${prefix}.command`, false);
    if (!command.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(command)) {
      invalid(`${prefix}.command must be an absolute path`);
    }
    if (!Array.isArray(server.args)) invalid(`${prefix}.args must be an array`);
    return { name, command, args: server.args.map((arg) => text(arg, `${prefix}.args`, true)),
      env: pairs(server.env, `${prefix}.env`, false) };
  });
}

export function assertMcpSupport(servers: readonly McpServer[], capabilities: McpCapabilities): void {
  for (const server of servers) {
    if (server.type === 'http' && !capabilities.http) invalid('HTTP transport is not supported by this driver');
    if (server.type === 'sse' && !capabilities.sse) invalid('SSE transport is not supported by this driver');
  }
}

export function claudeMcpConfig(servers: readonly McpServer[]): Record<string, unknown> {
  return { mcpServers: Object.fromEntries(servers.map((server) => [server.name,
    'command' in server
      ? { type: 'stdio', command: server.command, args: server.args, env: namedValues(server.env) }
      : { type: server.type, url: server.url, headers: namedValues(server.headers) },
  ])) };
}

/**
 * Codex's per-server MCP tool approval (`mcp_servers.<id>.default_tools_approval_mode`, documented in Codex's config
 * reference): `approve` runs the server's tools without asking; `prompt` always asks; `writes` asks for writes;
 * `auto` is Codex's own default.
 */
export type McpToolApproval = 'auto' | 'prompt' | 'writes' | 'approve';
const MCP_TOOL_APPROVALS: ReadonlySet<string> = new Set<McpToolApproval>(['auto', 'prompt', 'writes', 'approve']);

/**
 * App Server thread/start and thread/resume accept these JSON config overrides. `approval` names servers in `servers`
 * only, and only Codex's documented modes: anything else is refused, loudly, rather than dropped.
 */
export function codexMcpConfig(
  servers: readonly McpServer[],
  approval: Readonly<Record<string, McpToolApproval>> = {},
): Record<string, unknown> {
  assertMcpSupport(servers, { http: true, sse: false });
  const names = new Set(servers.map((server) => server.name));
  for (const [name, mode] of Object.entries(approval)) {
    if (!names.has(name)) invalid(`mcpToolApproval names ${JSON.stringify(name)}, which is not one of the MCP servers given`);
    if (!MCP_TOOL_APPROVALS.has(mode)) invalid(`mcpToolApproval for ${JSON.stringify(name)} is ${JSON.stringify(mode)}; Codex documents auto, prompt, writes and approve`);
  }
  return { mcp_servers: Object.fromEntries(servers.map((server) => {
    const mode = Object.prototype.hasOwnProperty.call(approval, server.name) ? approval[server.name] : undefined;
    const entry = 'command' in server
      ? { command: server.command, args: server.args, env: namedValues(server.env) }
      : { url: server.url, http_headers: namedValues(server.headers) };
    return [server.name, mode === undefined ? entry : { ...entry, default_tools_approval_mode: mode }];
  })) };
}

function namedValues(values: readonly McpNamedValue[]): Record<string, string> {
  // Assignment to an ordinary object would swallow a '__proto__' entry.
  return Object.fromEntries(values.map(({ name, value }) => [name, value]));
}

function pairs(value: unknown, field: string, header: boolean): McpNamedValue[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  const seen = new Set<string>();
  return value.map((entry: unknown): McpNamedValue => {
    const pair = object(entry);
    if (pair === undefined) invalid(`${field} entries must be objects`);
    const name = text(pair.name, `${field}.name`, false);
    if (header ? !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) : /[=\r\n]/.test(name)) {
      invalid(`${field} contains an invalid name`);
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) invalid(`${field} contains duplicate names`);
    seen.add(folded);
    const item = text(pair.value, `${field}.value`, true);
    if (header && /[\r\n]/.test(item)) invalid(`${field} contains an invalid header value`);
    return { name, value: item };
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, field: string, empty: boolean): string {
  if (typeof value !== 'string' || value.includes('\0') || (!empty && value.trim().length === 0)) {
    invalid(`${field} must be ${empty ? 'a' : 'a non-empty'} string without NUL`);
  }
  return value;
}

function invalid(reason: string): never {
  // Diagnostics name the field, never a URL, header, argument or credential.
  throw new RpcError(RPC_INVALID_PARAMS, `invalid mcpServers: ${reason}`);
}
