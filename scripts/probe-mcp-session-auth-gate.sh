#!/usr/bin/env bash
set -euo pipefail
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm test
mkdir -p .patch
npm pack --json --pack-destination .patch > .patch/packed.json
archive="$(node -p "JSON.parse(require('node:fs').readFileSync('.patch/packed.json','utf8'))[0].filename")"
tar -xzf ".patch/$archive" -C .patch
installed_binary() {
    local binary_path
    binary_path="$(command -v "$1")"
    if [[ "$binary_path" == */mise/shims/* ]]; then
        binary_path="$(mise which "$1")"
    fi
    readlink -f "$binary_path"
}
node_path="$(installed_binary node)"
codex_path="$(installed_binary codex)"
# The test image's Claude launcher installs/activates the tool on first use.
# Resolve its actual executable only after that online setup; do not carry the launcher into the namespace.
claude --version
claude_path="$(installed_binary claude)"
fixture_path="$(dirname "$node_path"):$(dirname "$codex_path"):$(dirname "$claude_path"):$PATH"
probe_path="$PWD/.patch/package"
run_native() {
    if [[ "${1:-all}" == env-* ]]; then
        sudo unshare --net --fork bash -c 'ip link set lo up; exec runuser -u genie -- env PATH="$2" PRISM_MCP_PROBE_FIXTURE_ONLY=1 PRISM_MCP_PROBE_ISOLATED=1 PRISM_CODEX_PROBE_BINARY="$4" PRISM_MCP_ENV_PROBE_PART="$5" "$1" scripts/probe-codex-mcp-env.mjs "$3"' probe "$node_path" "$fixture_path" "$probe_path" "$codex_path" "${1#env-}"
        return
    fi
    sudo unshare --net --fork bash -c 'ip link set lo up; exec runuser -u genie -- env PATH="$2" PRISM_MCP_PROBE_ISOLATED=1 PRISM_CODEX_PROBE_BINARY="$4" PRISM_CLAUDE_PROBE_BINARY="$5" PRISM_MCP_PROBE_PART="$6" "$1" scripts/probe-mcp-session-auth.mjs "$3"' probe "$node_path" "$fixture_path" "$probe_path" "$codex_path" "$claude_path" "${1:-all}"
}
cp .patch/package/dist/mcp.js .patch/mcp.original.js
cp .patch/package/dist/claude/driver.js .patch/claude-driver.original.js
restore_guards() {
    cp .patch/mcp.original.js .patch/package/dist/mcp.js
    cp .patch/claude-driver.original.js .patch/package/dist/claude/driver.js
}
trap restore_guards EXIT
reject_mutation() {
    local target="$1" before="$2" after="$3" part="$4" assertion="$5" label="$6"
    restore_guards
    python3 - "$target" "$before" "$after" <<'PYMUTATE'
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text(encoding='utf-8')
assert s.count(sys.argv[2]) == 1, 'mutation must match exactly one adapter guard'
p.write_text(s.replace(sys.argv[2],sys.argv[3]),encoding='utf-8',newline='\n')
PYMUTATE
    if run_native "$part" > .patch/mcp-auth-bypass.log 2>&1; then
        cat .patch/mcp-auth-bypass.log
        printf '%s\n' "FAIL: $label bypass did not fail its assertion" >&2
        exit 1
    fi
    if ! grep -Fq -- "$assertion" .patch/mcp-auth-bypass.log; then
        cat .patch/mcp-auth-bypass.log
        exit 1
    fi
    printf '%s\n' "RED: $label bypass fails its exact assertion."
}
reject_mutation .patch/package/dist/mcp.js 'entries[server.name].bearer_token_env_var = name;' 'delete entries[server.name].bearer_token_env_var;' all 'per-session bearer reaches expected endpoint' 'bearer binding'
reject_mutation .patch/package/dist/mcp.js 'config.features = { shell_snapshot: false };' 'config.features = { shell_snapshot: true };' all 'bearer-bearing sessions do not create environment snapshots' 'snapshot persistence guard'
reject_mutation .patch/package/dist/mcp.js 'enabled: false' 'enabled: true' codex-deny 'Codex deny prevents legacy requests through shutdown' 'Codex selective deny'
reject_mutation .patch/package/dist/claude/driver.js 'deniedMcpServers:' 'ignoredMcpServers:' claude-deny 'Claude deny prevents legacy requests through shutdown' 'Claude selective deny'
reject_mutation .patch/package/dist/mcp.js 'exclude: [...excluded, ...bindings]' 'exclude: [...excluded]' env-legacy 'MCP bearer is absent from native model-run env' 'legacy shell environment exclusion'
reject_mutation .patch/package/dist/mcp.js "filters: { ...filters, ...Object.fromEntries(bindings.map((name) => [name, 'exclude'])) }" 'filters: { ...filters }' env-filters 'MCP bearer is absent from native model-run env' 'keyed shell environment exclusion'
restore_guards
run_native
run_native env-legacy
run_native env-filters
