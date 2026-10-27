/**
 * Measured restriction, not a general claim about every Codex model or release.
 * Codex 0.163.0/gpt-6.1-sol still exposes callable orchestration/agent tools via
 * input.additional_tools after native feature flags are disabled, so it is refused.
 */
export const CODEX_NATIVE_TOOLS_NONE = Object.freeze({
  cliVersions: Object.freeze(['0.163.0'] as const),
  models: Object.freeze(['gpt-5.3-codex'] as const),
  residualTools: Object.freeze(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] as const),
});

/** Only locally constructed restriction diagnostics may cross the startup error boundary verbatim. */
export class CodexNativeToolsRefused extends Error {
  constructor(message: string) { super(message); this.name = 'CodexNativeToolsRefused'; }
}

export function assertRestrictedModel(model: string | undefined): void {
  if (model !== undefined && (CODEX_NATIVE_TOOLS_NONE.models as readonly string[]).includes(model)) return;
  const label = model === undefined ? '<CLI default>' : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ? model : '<invalid model id>';
  throw new CodexNativeToolsRefused(`nativeTools:'none' refuses model ${JSON.stringify(label)}: native execution/agent tools cannot be assumed removed; measured model is gpt-5.3-codex on Codex CLI 0.163.0`);
}

/** The native initialize result names its CLI version before any thread or API-key login. */
export function assertRestrictedCli(result: unknown): void {
  const userAgent = object(result)?.userAgent;
  const version = typeof userAgent === 'string'
    ? /^[^\s]+\/(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,80})?)(?:\s|$)/.exec(userAgent)?.[1]
    : undefined;
  if (version !== undefined && (CODEX_NATIVE_TOOLS_NONE.cliVersions as readonly string[]).includes(version)) return;
  throw new CodexNativeToolsRefused(`nativeTools:'none' refuses Codex CLI ${version ?? '<unverifiable>'}: only 0.163.0 has a measured native-tool surface`);
}

// Disable native capabilities explicitly, including ones an inherited home might enable.
// This policy is supported ONLY by the matrix above; new versions/models require measurement.
const NATIVE_FEATURES = [
  'shell_tool', 'shell_snapshot', 'view_image', 'multi_agent', 'multi_agent_v2',
  'apps', 'plugins', 'remote_plugin', 'tool_suggest', 'image_generation',
  'in_app_browser', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'sleep_tool', 'goals', 'hooks', 'skill_search', 'skill_mcp_dependency_install',
  'code_mode', 'code_mode_only', 'code_mode_host', 'code_mode_prewarm', 'code_mode_tool_search',
  'guardian_approval', 'guardian_conversation_history_tools', 'request_permissions_tool',
] as const;

/** Explicit feature settings measured without adding tools. Built-in defaults are pinned by the CLI matrix. */
const HARMLESS_FEATURES = new Set([
  'enable_request_compression', 'api_key_model_discovery', 'api_key_cyber_access_programs',
  'auth_elicitation', 'mentions_v2',
]);

// Thread config arrives after app-server startup. Native0.163.0 can clone a plugin marketplace before then.
export const RESTRICTED_STARTUP_ARGS: readonly string[] = Object.freeze([
  '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
]);

/** Refuse unmeasured home/project settings instead of assuming the finite native override list covers them. */
export function assertRestrictedConfig(effective: Record<string, unknown>): void {
  const features = optionalTable(effective.features, 'features');
  for (const name of ['plugins', 'remote_plugin']) {
    if (features[name] !== false) throw new CodexNativeToolsRefused(`nativeTools:'none' could not verify startup feature ${name}=false`);
  }
  for (const [name, value] of Object.entries(features)) {
    // These entries are always overwritten with false by the final restriction config.
    if ((NATIVE_FEATURES as readonly string[]).includes(name)) continue;
    if (value === false || value === null || (value === true && HARMLESS_FEATURES.has(name))) continue;
    throw new CodexNativeToolsRefused(`nativeTools:'none' refuses unmeasured feature ${safeName(name)}`);
  }
  const tools = optionalTable(effective.tools, 'tools');
  for (const name of Object.keys(tools)) {
    if (['experimental_request_user_input', 'update_plan', 'view_image'].includes(name) || tools[name] === null) continue;
    throw new CodexNativeToolsRefused(`nativeTools:'none' refuses unmeasured tools setting ${safeName(name)}`);
  }
  // These native tool/model configurations were absent from the measured homes.
  for (const name of ['model_catalog_json', 'browser_use', 'computer_use', 'desktop', 'code_mode', 'multi_agent_v2']) {
    if (effective[name] !== undefined && effective[name] !== null) {
      throw new CodexNativeToolsRefused(`nativeTools:'none' refuses unmeasured tool-shaping setting ${name}`);
    }
  }
}

function safeName(name: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name) ? JSON.stringify(name) : '<invalid setting name>';
}

function optionalTable(value: unknown, name: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  const table = object(value);
  if (table !== undefined) return table;
  throw new CodexNativeToolsRefused(`nativeTools:'none' could not verify effective ${name} configuration`);
}

export function restrictedToolConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...config,
    features: { ...object(config?.features), ...Object.fromEntries(NATIVE_FEATURES.map((key) => [key, false])) },
    tools: { experimental_request_user_input: { enabled: false }, update_plan: { enabled: false }, view_image: false },
    cloud: { skills: { enabled: false } },
    skills: { include_instructions: false },
    web_search: 'disabled',
    approvals_reviewer: 'user',
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
