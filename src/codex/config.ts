import { types } from 'node:util';

/** Per-thread app-server configuration. Values are copied before asynchronous startup. */
export type CodexConfigValue = null | boolean | number | string | readonly CodexConfigValue[] | { readonly [key: string]: CodexConfigValue };
export type CodexConfig = Readonly<Record<string, CodexConfigValue>>;

const OWNED = [
  'mcp_servers', 'shell_environment_policy', 'features.shell_snapshot',
  'approval_policy', 'sandbox_mode', 'model', 'model_provider', 'model_providers', 'profile', 'profiles',
] as const;
const RESTRICTED = [
  'features', 'tools', 'cloud', 'web_search', 'approvals_reviewer', 'skills.include_instructions',
  'model_catalog_json', 'browser_use', 'computer_use', 'desktop', 'code_mode', 'multi_agent_v2',
] as const;
function invalid(): never { throw new Error('config must contain bounded JSON-safe data without driver-owned or ambiguous paths'); }
function table(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(right + '.') || right.startsWith(left + '.'); }

/** No getters/toJSON, prototype objects, lossy values, sparse arrays or cycles. */
export function readCodexConfig(value: unknown, restricted: boolean): CodexConfig | undefined {
  if (value === undefined) return undefined;
  if (!table(value)) invalid();
  let nodes = 0, bytes = 0; const seen = new Set<object>();
  const text = (value: string): void => { if (value.length > 524288) invalid(); bytes += Buffer.byteLength(value); if (bytes > 524288) invalid(); };
  function copy(value: unknown, depth: number): CodexConfigValue {
    if (++nodes > 10000 || depth > 32) invalid();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
    if (typeof value === 'string') { text(value); return value; }
    if (typeof value !== 'object' || value === null || types.isProxy(value) || (!Array.isArray(value) && !table(value)) || seen.has(value)) invalid();
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(d => !('value' in d))) invalid();
    let result: CodexConfigValue;
    if (Array.isArray(value)) {
      if (value.length > 10000 || Object.keys(descriptors).length !== value.length + 1 || Object.keys(descriptors).some(k => k !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(k))) invalid();
      result = Array.from({ length: value.length }, (_, i) => {
        const item = descriptors[String(i)]; if (!item?.enumerable) invalid(); return copy(item.value, depth + 1);
      });
    } else {
      const record: Record<string, CodexConfigValue> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid(); text(key); record[key] = copy(descriptor.value, depth + 1);
      }
      result = record;
    }
    seen.delete(value); return Object.freeze(result);
  }
  const cloned = copy(value, 0) as CodexConfig;
  const keys = Object.keys(cloned), normalized: Record<string, CodexConfigValue> = Object.create(null), blocked: readonly string[] = restricted ? [...OWNED, ...RESTRICTED] : OWNED;
  for (const key of keys) {
    if (key.length > 256 || !/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*(?![\s\S])/.test(key) || key.split('.').some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) invalid();
    if (keys.some(other => other !== key && overlaps(key, other))) invalid();
    let at = normalized; const parts = key.split('.');
    for (const part of parts.slice(0, -1)) at = (at[part] ??= Object.create(null)) as Record<string, CodexConfigValue>;
    at[parts.at(-1)!] = cloned[key];
  }
  function check(current: CodexConfigValue, path: string, depth: number): void {
    if (depth > 32) invalid();
    if (table(current) && Object.keys(current).length > 0) { for (const [key, child] of Object.entries(current)) check(child as CodexConfigValue, path ? path + '.' + key : key, depth + 1); return; }
    // This explicit value agrees with the driver's restriction; a caller may
    // select it in either mode, but cannot turn instructions back on in 'none'.
    if (restricted && path === 'skills.include_instructions' && current === false) return;
    if (blocked.some(owned => overlaps(path, owned))) invalid();
  }
  for (const [key, child] of Object.entries(normalized)) check(child, key, 1);
  if (Buffer.byteLength(JSON.stringify(normalized)) > 524288) invalid();
  return freeze(normalized) as CodexConfig;
}
function freeze(value: CodexConfigValue): CodexConfigValue {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Driver-owned controls combine with caller data; validation refuses collisions. */
export function mergeCodexConfig(config: CodexConfig | undefined, owned: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (config === undefined) return owned;
  function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
    const result = { ...left };
    for (const [key, value] of Object.entries(right)) result[key] = table(value) && table(result[key]) ? merge(result[key] as Record<string, unknown>, value) : value;
    return result;
  }
  return merge(config, owned ?? {});
}
