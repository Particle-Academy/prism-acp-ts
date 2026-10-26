/** Inspect the entire model-facing tool surface, including the code-mode input representation. */
export function advertisedTools(body: unknown): readonly string[] {
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model request object');
    return value as Record<string, unknown>;
  };
  const request = object(body);
  const fields = new Set(['model', 'stream', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'include',
    'prompt_cache_key', 'client_metadata', 'text', 'instructions', 'metadata', 'max_output_tokens', 'temperature', 'top_p',
    'service_tier', 'truncation', 'previous_response_id', 'conversation', 'background', 'safety_identifier', 'stream_options',
    'prompt', 'context_management', 'prompt_cache_retention']);
  for (const key of Object.keys(request)) if (!fields.has(key)) throw new Error('Unreviewed model request field');
  const names = new Set<string>();
  let count = 0;
  const read = (raw: unknown, prefix = '', depth = 0): void => {
    if (!Array.isArray(raw) || depth > 8) throw new Error('Invalid model tool list');
    for (const entry of raw) {
      if (++count > 1000) throw new Error('Model tool list exceeds probe bound');
      const tool = object(entry);
      if (tool.type === 'namespace') {
        if (typeof tool.name !== 'string' || !tool.name) throw new Error('Unnamed model tool namespace');
        read(tool.tools, `${prefix}${tool.name}.`, depth + 1);
      } else if (tool.type === 'function' || tool.type === 'custom') {
        if (typeof tool.name !== 'string' || !tool.name || 'tools' in tool) throw new Error('Invalid callable model tool');
        names.add(prefix + tool.name);
      } else {
        // Hosted/native types (including a future type) must still appear in the exact-set comparison.
        if (typeof tool.type !== 'string' || !new Set(['web_search', 'web_search_preview', 'image_generation', 'computer',
          'computer_use_preview', 'shell', 'local_shell', 'file_search', 'mcp', 'code_interpreter', 'tool_search',
          'apply_patch', 'programmatic_tool_calling']).has(tool.type) || 'tools' in tool) throw new Error('Unknown model tool shape');
        names.add(`${prefix}@${tool.type}`);
      }
    }
  };
  if ('tools' in request) read(request.tools);
  if (!Array.isArray(request.input)) throw new Error('Invalid model input list');
  const ordinary = new Set(['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning', 'compaction']);
  for (const raw of request.input) {
    const item = object(raw);
    if (item.type === 'additional_tools') read(item.tools);
    else if (!ordinary.has(String(item.type)) || 'tools' in item) throw new Error('Unreviewed model input shape');
  }
  return [...names].sort();
}
