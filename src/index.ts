export { MAX_LINE_BYTES, NdjsonFramer, encodeLine, parseLine } from './ndjson.js';
export type { Frame, FrameError } from './ndjson.js';

export { BASE_ALLOW, OUTRANKING_CREDENTIALS, childEnv } from './env.js';
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
  META_NS,
  META_RATE_LIMIT,
  META_THINKING_SIGNATURE,
  META_THINKING_TOKENS_ESTIMATE,
  META_UNMAPPED_FRAME,
  RESERVED_META_KEYS,
  metaKey,
  withMeta,
} from './meta.js';

export { ClaudeToAcp } from './claude/to-acp.js';
export type { AcpUpdate, ToolStatus } from './claude/to-acp.js';

export { ClaudeDriver, claudeArgs, promptLine, updatesFromFrames } from './claude/driver.js';
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
  DriverFactory,
} from './acp/agent.js';

export { serve } from './acp/stdio.js';
export type { Served, ServeOptions } from './acp/stdio.js';

export { cliSessionIdOf, turnOutcomeOf } from './claude/driver.js';
export type { StopReason, TurnOutcome } from './claude/driver.js';
