import { RpcError, RPC_INVALID_PARAMS } from './jsonrpc.js';
import { randomBytes } from 'node:crypto';

/** ACP session MCP configuration. The client supplies explicit credentials here. */
export interface McpNamedValue { readonly name: string; readonly value: string }
export type McpServer =
  | { readonly type?: 'stdio'; readonly name: string; readonly command: string;
      readonly args: readonly string[]; readonly env: readonly McpNamedValue[] }
  | { readonly type: 'http' | 'sse'; readonly name: string; readonly url: string;
      readonly headers: readonly McpNamedValue[] };

export interface McpCapabilities { readonly http: boolean; readonly sse: boolean }

/** Trusted driver policy, copied and checked before asynchronous startup. Never an ACP/model argument. */
export function readDisabledMcpServers(value: unknown, servers: readonly McpServer[]): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('disabledMcpServers must be an array of distinct non-empty names');
  const active = new Set(servers.map((server) => server.name));
  const seen = new Set<string>();
  return value.map((name: unknown) => {
    if (typeof name !== 'string' || name.trim() !== name || name.length === 0 || /[\x00-\x1f\x7f]/.test(name) || seen.has(name) || active.has(name)) {
      throw new Error('disabledMcpServers must contain distinct valid names, separate from explicit mcpServers');
    }
    seen.add(name); return name;
  });
}

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

/**
 * Native Codex merges a session server with inherited fields. Its bearer_token_env_var outranks an explicit
 * Authorization header. Bind each supplied bearer to a fresh variable in THIS child's environment and include
 * that binding in thread/start AND thread/resume. Neither ambient env nor argv is modified.
 */
export function codexMcpSessionConfig(servers: readonly McpServer[], approval?: Readonly<Record<string, McpToolApproval>>): {
  config: Record<string, unknown> | undefined; env: Readonly<Record<string, string>>;
} {
  if (servers.length === 0) return { config: undefined, env: {} };
  const config = codexMcpConfig(servers, approval);
  const entries = config.mcp_servers as Record<string, Record<string, unknown>>;
  const env = new Map<string, string>();
  for (const server of servers) {
    if ('command' in server) continue;
    const authorization = server.headers.find((header) => header.name.toLowerCase() === 'authorization')?.value;
    if (authorization === undefined || !/^Bearer(?:\s|$)/i.test(authorization)) continue;
    const token = /^Bearer[ \t]+(\S+)$/i.exec(authorization)?.[1];
    if (!token) invalid('Bearer Authorization must contain a non-empty token without whitespace');
    const name = `PRISM_ACP_MCP_TOKEN_${randomBytes(16).toString('hex').toUpperCase()}`;
    env.set(name, token);
    entries[server.name].bearer_token_env_var = name;
    // Keep the secret out of thread config/rollout metadata. Native auth uses only the private child binding.
    entries[server.name].http_headers = Object.fromEntries(Object.entries(entries[server.name].http_headers as Record<string, string>)
      .filter(([header]) => header.toLowerCase() !== 'authorization'));
  }
  // Native shell snapshots persist exported environment values even without a shell tool call.
  // Do not let a per-session bearer become a plaintext file in the shared CLI home.
  if (env.size > 0) config.features = { shell_snapshot: false };
  return { config, env: Object.fromEntries(env) };
}

/** A missing disabled entry still needs a valid native transport. Never add URL fields to an existing stdio entry. */
export function codexMcpDisabledConfig(config: Record<string, unknown> | undefined, disabled: readonly string[], inherited: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(object(config?.mcp_servers) ?? {});
  for (const name of disabled) {
    const present = Object.prototype.hasOwnProperty.call(inherited, name);
    const existing = present ? object(inherited[name]) : undefined;
    if (present && existing === undefined) throw new Error('Codex returned invalid inherited MCP configuration');
    let transport: Record<string, unknown>;
    if (existing === undefined) transport = { url: 'http://127.0.0.1:1' };
    else if (typeof existing.command === 'string' && existing.command.length > 0) {
      if (existing.args !== undefined && (!Array.isArray(existing.args) || existing.args.some((arg) => typeof arg !== 'string'))) throw new Error('Codex returned invalid inherited MCP configuration');
      transport = { command: existing.command, ...(existing.args === undefined ? {} : { args: existing.args }) };
    } else if (typeof existing.url === 'string' && existing.url.length > 0) transport = { url: existing.url };
    else throw new Error('Codex returned invalid inherited MCP transport');
    entries.push([name, { ...transport, enabled: false }]);
  }
  return { ...config, mcp_servers: Object.fromEntries(entries) };
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
