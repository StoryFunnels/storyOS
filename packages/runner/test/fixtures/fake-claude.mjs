#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/* global process, console, setInterval */
/**
 * A FAKE `claude` for the Claude Code adapter's tests. It speaks the shapes the premise check on ticket #1135 quoted from the real
 * CLI (2.1.104): `--version`, `auth status`, and `-p --output-format stream-json --verbose`.
 *
 * What is REAL in these shapes: the init event, the assistant event with `error`, and the result event (the authentication failure
 * is a captured run). What is NOT real: the limit-stop events (`rate_limit_event`, `error: "rate_limit"`) are the CLI's own schema
 * read from its binary, never seen from a live limit, and the success numbers are invented. This file proves what the ADAPTER does
 * with those shapes, not that the CLI emits them.
 *
 * It records how it was called (argv, stdin, whether the credential reached it, the MCP config as it was AT RUN TIME) into the file
 * named by FAKE_CLAUDE_RECORD, and acts out the mode named by FAKE_CLAUDE_MODE.
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
const sessionId = '5b2f7f6e-3c1a-4e55-9a37-0f1c2d3e4a5b';

if (argv[0] === '--version') {
  console.log('2.1.104 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== 'false', authMethod: 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}

const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
await new Promise((r) => process.stdin.on('end', r));

const record = process.env.FAKE_CLAUDE_RECORD;
if (record) {
  const cfgPath = flag('--mcp-config');
  let cfg = null;
  let cfgMode = null;
  try {
    cfg = readFileSync(cfgPath, 'utf8');
    cfgMode = statSync(cfgPath).mode & 0o777;
  } catch {
    // recorded as null
  }
  writeFileSync(
    record,
    JSON.stringify({
      argv,
      stdin,
      cwd: process.cwd(),
      tokenInEnv: process.env.STORYOS_RUN_TOKEN ?? null,
      apiKeyInEnv: process.env.ANTHROPIC_API_KEY ?? null,
      runnerTokenInEnv: process.env.STORYOS_RUNNER_TOKEN ?? null,
      mcpConfigPath: cfgPath ?? null,
      mcpConfig: cfg,
      mcpConfigMode: cfgMode,
    }),
  );
}

const init = {
  type: 'system',
  subtype: 'init',
  cwd: process.cwd(),
  session_id: sessionId,
  tools: ['mcp__storyos__add_comment'],
  mcp_servers: [{ name: 'storyos', status: process.env.FAKE_CLAUDE_MCP_STATUS ?? 'connected' }],
  model: 'claude-fake',
  permissionMode: flag('--permission-mode') ?? 'default',
  apiKeySource: 'none',
  claude_code_version: '2.1.104',
};
const usage = { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 450, output_tokens: 77 };
const result = (extra) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1200,
  duration_api_ms: 1000,
  num_turns: 3,
  result: 'Commented on #12 and moved it to Review.',
  stop_reason: 'end_turn',
  session_id: sessionId,
  total_cost_usd: 0.01,
  usage,
  permission_denials: [],
  terminal_reason: 'completed',
  ...extra,
});

emit({ type: 'system', subtype: 'hook_started', hook_name: 'ignored' });
emit(init);

switch (mode) {
  case 'success':
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__storyos__add_comment', input: { body: 'SECRET-LOOKING-INPUT-NEVER-LOGGED' } }] } });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    emit({ type: 'future_event_we_do_not_know', anything: 1 });
    process.stdout.write('this line is not json\n');
    emit(result({}));
    process.exit(0);
    break;
  case 'denied':
    emit(
      result({
        result: 'I could not run the command, so I only commented.',
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'cat ~/.ssh/id_rsa' } },
          { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'ls' } },
        ],
      }),
    );
    process.exit(0);
    break;
  case 'limit': {
    const reset = process.env.FAKE_CLAUDE_RESET ?? String(Math.floor(Date.now() / 1000) + 3 * 3600);
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: Number(reset), rateLimitType: 'five_hour', utilization: 0.9 } });
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Number(reset), rateLimitType: 'five_hour' } });
    emit({ type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 3pm" }] } });
    emit(result({ is_error: true, result: "You've hit your session limit · resets 3pm", usage: { ...usage, output_tokens: 0 } }));
    process.exit(1);
    break;
  }
  case 'limit_text_only':
    emit(result({ is_error: true, result: "You've hit your weekly limit · resets Mon 9am" }));
    process.exit(1);
    break;
  case 'auth':
    // Captured from the real CLI on the machine this was built on (request id replaced).
    emit({ type: 'assistant', error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."},"request_id":"req_X"}' }] } });
    emit(result({ is_error: true, result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."},"request_id":"req_X"}', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, duration_api_ms: 0 }));
    process.exit(1);
    break;
  case 'max_turns':
    emit(result({ subtype: 'error_max_turns', is_error: true, result: '' }));
    process.exit(1);
    break;
  case 'crash':
    process.stderr.write(`boom: Authorization: Bearer ${process.env.STORYOS_RUN_TOKEN} was rejected\n`);
    process.exit(3);
    break;
  case 'hang':
  case 'hang_stubborn': {
    // A grandchild in the same process group: killing only this process would leave it behind.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    if (process.env.FAKE_CLAUDE_CHILD_PID) writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID, String(child.pid));
    if (process.env.FAKE_CLAUDE_SELF_PID) writeFileSync(process.env.FAKE_CLAUDE_SELF_PID, String(process.pid));
    if (mode === 'hang_stubborn') process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1000);
    break;
  }
  default:
    process.exit(9);
}
