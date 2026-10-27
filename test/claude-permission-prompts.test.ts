import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareProcessTree } from '../src/process-tree.js';
import { claudeArgs } from '../src/claude/driver.js';
import { ApprovalServer, HOOK_SCRIPT, approvalSettings, decisionFor, permissionRequestFor } from '../src/claude/approvals.js';

/**
 * CLAUDE ASKS A PERSON BEFORE A TOOL RUNS (issue #1). ClaudeDriver raised no permission requests, so a client could
 * only pre-decide (bypass, or acceptEdits) — never put a human in the loop as CodexDriver does. The documented, measured
 * route is a PreToolUse command hook supplied with `--settings` for this one invocation:
 *
 *  - measured 2026-10-13 on claude-code 2.1.296 (`-p`, stream-json): a `--settings` PreToolUse hook fires; it receives
 *    { session_id, tool_name, tool_input, tool_use_id, cwd, permission_mode, ... }; its `deny` stopped the Bash call and
 *    the reason reached the model; an `allow` returned after a 20 s wait let the call run (29 s, against 8 s without).
 *
 * The hook script hands the call to the driver over a private socket with a random token; the driver raises the same
 * `PermissionRequest` Codex does and answers with the client's choice. ANYTHING BUT AN EXPLICIT ALLOW IS A DENY: a wrong
 * token, no server, no handler, a cancelled request — the hook fails closed.
 */
const dirs: string[] = [];
beforeAll(async () => { await prepareProcessTree(); }, 60000);
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'prism-approvals-')); dirs.push(d); return d; };
const socketIn = (dir: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\prism-acp-test-${Math.random().toString(36).slice(2)}` : join(dir, 'a.sock'));

const INPUT = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Clean the build' }, tool_use_id: 'toolu_1', cwd: '/w', permission_mode: 'default', hook_event_name: 'PreToolUse' };

/** Run the REAL hook script the way Claude would: stdin = the hook input, env = the socket and token. */
function runHook(env: Record<string, string>, input: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const dir = tmp();
    const script = join(dir, 'hook.cjs');
    writeFileSync(script, HOOK_SCRIPT);
    return new Promise((resolve) => {
        const start = performance.now();
        const settings = approvalSettings(process.execPath, script, ['Bash']) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; args: string[] }> }> } };
        const hook = settings.hooks.PreToolUse[0]!.hooks[0]!;
        const child = spawn(hook.command, hook.args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        const pending = setTimeout(() => console.info(JSON.stringify({ approvalCommandTiming: 'still pending', platform: process.platform, elapsedMs: performance.now() - start, stdoutBytes: Buffer.byteLength(stdout) })), 4500);
        child.on('close', (code) => {
            clearTimeout(pending);
            console.info(JSON.stringify({ approvalCommandTiming: 'closed', platform: process.platform, elapsedMs: performance.now() - start, code, stdoutBytes: Buffer.byteLength(stdout) }));
            resolve({ code, stdout, stderr });
        });
        child.stdin.end(JSON.stringify(input));
    });
}
const decision = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }).hookSpecificOutput;

describe('the arguments and the settings', () => {
    it('claudeArgs carries --settings when a settings file is given; none otherwise', () => {
        const args = claudeArgs({ cwd: '/w' }, undefined, '/tmp/x/settings.json');
        expect(args[args.indexOf('--settings') + 1]).toBe('/tmp/x/settings.json');
        expect(claudeArgs({ cwd: '/w' })).not.toContain('--settings');
    });

    it('one PreToolUse command hook for the named tools, failing closed, with a long wait for a person', () => {
        const s = approvalSettings('/opt/node', '/tmp/x/hook.cjs', ['Bash', 'WebFetch']) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> } };
        expect(s.hooks.PreToolUse).toHaveLength(1);
        expect(s.hooks.PreToolUse[0]!.matcher).toBe('Bash|WebFetch');
        const hook = s.hooks.PreToolUse[0]!.hooks[0]!;
        expect(hook).toMatchObject({ type: 'command', onFailure: 'block' });
        expect(hook.timeout as number).toBeGreaterThanOrEqual(3600);
        expect(hook.args).toBeInstanceOf(Array); // exec form; paths never pass through Claude's shell parser
        expect(hook.command).toMatch(/(?:prism-acp-supervisor-[0-9a-f]{64}\.exe|\/bin\/sh)$/);
    });

    it('a tool name that would widen the matcher is refused', () => {
        expect(() => approvalSettings('/opt/node', '/h.cjs', ['Bash|.*'])).toThrow(/tool/);
        expect(() => approvalSettings('/opt/node', '/h.cjs', [])).toThrow(/tool/);
    });
});

describe('the request and the decision', () => {
    it('the hook input becomes the same PermissionRequest Codex raises: the call, Allow once and Deny', () => {
        const r = permissionRequestFor(INPUT);
        expect(r.toolCall).toMatchObject({ toolCallId: 'toolu_1', title: 'Bash: rm -rf build', rawInput: INPUT.tool_input });
        expect(r.options.map((o) => [o.optionId, o.kind])).toEqual([['allow_once', 'allow_once'], ['reject_once', 'reject_once']]);
    });

    it('only an explicit allow allows; a rejection, a cancel, or an unknown option denies', () => {
        expect(decisionFor({ outcome: 'selected', optionId: 'allow_once' }).permissionDecision).toBe('allow');
        expect(decisionFor({ outcome: 'selected', optionId: 'reject_once' }).permissionDecision).toBe('deny');
        expect(decisionFor({ outcome: 'cancelled' }).permissionDecision).toBe('deny');
        expect(decisionFor({ outcome: 'selected', optionId: 'something-else' }).permissionDecision).toBe('deny');
    });
});

describe('the hook script against the approval server (end to end, both real)', () => {
    it('the person allows: the hook prints allow; the server saw the call', async () => {
        const start = performance.now();
        const seen: unknown[] = [];
        const server = new ApprovalServer(socketIn(tmp()), async (input) => { console.info(JSON.stringify({ approvalFirstRequestMs: performance.now() - start })); seen.push(input); return { outcome: 'selected', optionId: 'allow_once' }; });
        const { socket, token } = server.listen();
        const r = await runHook({ PRISM_ACP_APPROVAL_SOCKET: socket, PRISM_ACP_APPROVAL_TOKEN: token }, INPUT);
        server.close();
        expect(r.code).toBe(0);
        expect(decision(r.stdout).permissionDecision).toBe('allow');
        expect(seen).toEqual([INPUT]);
    });

    it('the person denies: deny, with the reason', async () => {
        const server = new ApprovalServer(socketIn(tmp()), async () => ({ outcome: 'selected', optionId: 'reject_once' }));
        const { socket, token } = server.listen();
        const r = await runHook({ PRISM_ACP_APPROVAL_SOCKET: socket, PRISM_ACP_APPROVAL_TOKEN: token }, INPUT);
        server.close();
        expect(decision(r.stdout)).toMatchObject({ permissionDecision: 'deny' });
        expect(decision(r.stdout).permissionDecisionReason).toMatch(/denied/i);
    });

    it("a refusal that carries the client's reason reaches Claude with exactly that text (tynn, Genie shell limits)", async () => {
        const reason = 'Genie: this workspace already runs 3 of 3 shells (npm run dev, vitest, php artisan queue:work). Stop one first.';
        for (const outcome of [
            { outcome: 'selected', optionId: 'reject_once', reason },
            { outcome: 'cancelled', reason },
        ] as const) {
            const server = new ApprovalServer(socketIn(tmp()), async () => outcome);
            const { socket, token } = server.listen();
            const r = await runHook({ PRISM_ACP_APPROVAL_SOCKET: socket, PRISM_ACP_APPROVAL_TOKEN: token }, INPUT);
            server.close();
            expect(r.code).toBe(2);
            expect(decision(r.stdout)).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason });
        }
    });

    it("an allow the client made itself carries its reason to Claude, exactly (tynn, Genie shell limits)", async () => {
        const reason = 'Allowed by Genie (2 of 4 agent shells in use).';
        const server = new ApprovalServer(socketIn(tmp()), async () => ({ outcome: 'selected', optionId: 'allow_once', reason }));
        const { socket, token } = server.listen();
        const r = await runHook({ PRISM_ACP_APPROVAL_SOCKET: socket, PRISM_ACP_APPROVAL_TOKEN: token }, INPUT);
        server.close();
        expect(r.code).toBe(0);
        expect(decision(r.stdout)).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason });
    });

    it("CONTROL: no reason, or an empty one, keeps today's text; a reason never turns a refusal into an allow", () => {
        expect(decisionFor({ outcome: 'selected', optionId: 'reject_once' }).permissionDecisionReason).toBe('The person denied this tool call.');
        expect(decisionFor({ outcome: 'selected', optionId: 'reject_once', reason: '' }).permissionDecisionReason).toBe('The person denied this tool call.');
        expect(decisionFor({ outcome: 'cancelled' }).permissionDecisionReason).toBe('The request was cancelled.');
        expect(decisionFor({ outcome: 'selected', optionId: 'not-offered', reason: 'allow it' }).permissionDecision).toBe('deny');
        expect(decisionFor({ outcome: 'selected', optionId: 'allow_once' })).toEqual({
            hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Allowed by the person.',
        });
        expect(decisionFor({ outcome: 'selected', optionId: 'allow_once', reason: '' }).permissionDecisionReason).toBe('Allowed by the person.');
    });

    it('fails closed: a wrong token, or no server at all, blocks the call (exit 2) — never an allow', async () => {
        const server = new ApprovalServer(socketIn(tmp()), async () => ({ outcome: 'selected', optionId: 'allow_once' }));
        const { socket } = server.listen();
        const wrong = await runHook({ PRISM_ACP_APPROVAL_SOCKET: socket, PRISM_ACP_APPROVAL_TOKEN: 'not-the-token' }, INPUT);
        server.close();
        expect(wrong.code).toBe(2);
        expect(wrong.stdout).not.toMatch(/"allow"/);
        const none = await runHook({ PRISM_ACP_APPROVAL_SOCKET: socketIn(tmp()), PRISM_ACP_APPROVAL_TOKEN: 'x' }, INPUT);
        expect(none.code).toBe(2);
        expect(none.stdout).not.toMatch(/"allow"/);
    });
});
