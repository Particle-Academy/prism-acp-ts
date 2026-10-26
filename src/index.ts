export { MAX_LINE_BYTES, NdjsonFramer, encodeLine, parseLine } from './ndjson.js';
export type { Frame, FrameError } from './ndjson.js';
export type { McpCapabilities, McpNamedValue, McpServer } from './mcp.js';

export { BASE_ALLOW, OUTRANKING_CREDENTIALS, childEnv } from './env.js';
export { apiKeyEnvironment, apiKeyHome } from './credentials.js';
export type { ApiKeyHome, CredentialProvider, ProviderCredentials } from './credentials.js';
export type { ChildEnvOptions, ChildEnvResult } from './env.js';

export {
  JsonRpcPeer,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RpcError,
} from './jsonrpc.js';
export type {
  JsonRpcPeerOptions,
  NotificationHandler,
  RequestHandler,
  RpcId,
} from './jsonrpc.js';

export {
  META_BACKGROUND_TASKS,
  META_CLI_SESSION_ID,
  META_COMMAND_SOURCE,
  META_COMPACTION,
  META_LOCAL_COMMAND,
  META_PERMISSION_REASON,
  META_MODEL_INFO,
  META_MODEL,
  META_PLUGINS,
  META_SUBAGENTS,
  assertModel,
  META_DRIVER_CAPABILITIES,
  META_EXEC_POLICY_AMENDMENT,
  META_PERMISSION_DENIED,
  META_MCP_SERVERS,
  META_NS,
  META_PARENT_TOOL_CALL,
  META_RATE_LIMIT,
  META_TASK,
  META_THINKING_SIGNATURE,
  META_THINKING_TOKENS_ESTIMATE,
  META_TURN_FAILURE,
  META_UNMAPPED_FRAME,
  META_USAGE,
  RESERVED_META_KEYS,
  metaKey,
  withMeta,
} from './meta.js';

export { PROMPT_IMAGE_TYPES, PromptRefused, fileAsText, promptBlockKind, promptBlocks } from './prompt.js';
export type {
  BlobResource,
  ImageBlock,
  PromptBlock,
  PromptBlockKind,
  PromptContent,
  ResourceBlock,
  TextBlock,
  TextResource,
} from './prompt.js';

export { stripAnsiControlSequences } from './text.js';
export type { SanitizedProviderText } from './text.js';

export { ClaudeToAcp } from './claude/to-acp.js';
export type { AcpUpdate, ToolStatus } from './claude/to-acp.js';

export { claudeMcpServers, codexListedReport, codexStartupReport } from './mcp-status.js';
export type { McpServerReport, McpServerState } from './mcp-status.js';
export { parseRateLimit, rateLimitNotice, readRateLimit } from './claude/rate-limit.js';
export type { ClaudeRateLimit, ClaudeRateLimitWindow, RateLimitRead } from './claude/rate-limit.js';

export {
  CLAUDE_DRIVER_CAPABILITIES,
  ClaudeDriver,
  claudeArgs,
  promptLine,
  updatesFromFrames,
} from './claude/driver.js';
export type {
  ClaudeDriverEvents,
  ClaudeDriverOptions,
  ClaudePermissionMode,
} from './claude/driver.js';

export { AcpAgent, PROTOCOL_VERSION } from './acp/agent.js';
export type {
  AcpAgentOptions,
  AgentDriver,
  DriverEvents,
  ProblemDetail,
  DriverFactory,
  DriverCapabilities,
  PermissionOutcome,
  PermissionRequest,
  SessionProbe as AcpSessionProbe,
} from './acp/agent.js';

export { probeSessionStore } from './claude/session-store.js';
export type { SessionExistence, SessionProbe, SessionStoreOptions } from './claude/session-store.js';

export { serve } from './acp/stdio.js';
export type { Served, ServeOptions } from './acp/stdio.js';

export { cliSessionIdOf, turnOutcomeOf } from './claude/driver.js';
export type { StopReason, TurnOutcome } from './claude/driver.js';
export { ClaudeTurnFailures, codexFailureOf } from './turn-failure.js';
export type { TurnFailure, TurnFailureKind } from './turn-failure.js';

export { CODEX_DRIVER_CAPABILITIES, CodexDriver } from './codex/driver.js';
export type { CodexDriverOptions, CodexTransportFactory } from './codex/driver.js';
export { codexRateLimitNotice, parseCodexRateLimit, readCodexRateLimit } from './codex/rate-limit.js';
export type { CodexRateLimit, CodexRateLimitRead, CodexRateLimitWindow } from './codex/rate-limit.js';
export { ProcessTreeError, launchProvider, prepareProcessTree } from './process-tree.js';
export { ModelListError, listModels } from './models.js';
export type { AvailableModel, ListModelsOptions, SessionModelState } from './models.js';
export type { Containment, LaunchOptions, ProcessTreeOptions, ProcessTree, ProviderIo, ProviderProcess, StopOptions, StopVerdict } from './process-tree.js';
