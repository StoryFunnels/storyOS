#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * One real wake, end to end, on THIS computer, against a StoryOS API you started locally (see claude-code-smoke.md).
 *
 * It creates a THROWAWAY account, workspace, agent and lead in the LOCAL database, pairs and starts the built Runner with your own
 * logged-in `claude`, hands the lead to the agent, waits, and prints what happened. It never talks to a hosted StoryOS, and it
 * refuses any API address that is not on this computer.
 *
 *   node packages/runner/docs/smoke-local.mjs
 *
 * Environment (all optional):
 *   SMOKE_API   the local API        (default http://127.0.0.1:3001)
 *   SMOKE_MCP   the local MCP server (default http://127.0.0.1:3002/mcp)
 *   SMOKE_DB    the local Postgres database the API uses, read with `psql` for select-option ids (REQUIRED)
 *   SMOKE_WAIT  minutes to wait for the run (default 10)
 *   SMOKE_KEEP  1 = keep this run's directory (its Runner log) instead of cleaning up
 *   SMOKE_ALLOW_UNVERIFIED_CLI  1 = run even though the installed claude is not a version this adapter was verified on
 * Everything else the Runner reads (STORYOS_RUNNER_CLAUDE_BIN, STORYOS_RUNNER_RUN_TIMEOUT_MINUTES, ...) passes through.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = (process.env.SMOKE_API ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
const MCP = process.env.SMOKE_MCP ?? 'http://127.0.0.1:3002/mcp';
const DB = process.env.SMOKE_DB;
const WAIT_MS = Number(process.env.SMOKE_WAIT ?? '10') * 60_000;
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const RUNNER = join(DIST, 'index.js');

const host = new URL(API).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error(`Refusing ${API}: this script creates throwaway data and only runs against an API on this computer.`);
if (!DB) throw new Error('Set SMOKE_DB to the local database name the API uses (it is read with psql).');
if (!existsSync(RUNNER)) throw new Error('Build the Runner first: pnpm --filter @storyos/runner build');
const { createRunDir } = await import(pathToFileURL(join(DIST, 'smoke-run-dir.js')).href);
const { judgeCliVersion } = await import(pathToFileURL(join(DIST, 'adapters', 'claude-code', 'pins.js')).href);

// Preflight: the adapter relies on an UNDOCUMENTED claude setting verified only on the versions in pins.ts. Same list as the test.
{
  const bin = process.env.STORYOS_RUNNER_CLAUDE_BIN ?? 'claude';
  let out = '';
  try { out = execFileSync(bin, ['--version'], { timeout: 10_000 }).toString(); } catch { out = ''; }
  const verdict = judgeCliVersion(out);
  if (!verdict.verified) {
    console.error(`\n!!! UNVERIFIED CLAUDE VERSION !!!\n${verdict.message}\n`);
    if (process.env.SMOKE_ALLOW_UNVERIFIED_CLI !== '1') throw new Error('Refusing to run. Set SMOKE_ALLOW_UNVERIFIED_CLI=1 to run anyway and watch for "mcp storyos=pending" in the Runner log.');
  }
}

const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}
const say = (m) => console.log(`\n== ${m}`);

// A throwaway local account. The password is random and never printed or kept.
const email = `smoke-${Date.now()}@smoke.local`;
const signup = await fetch(`${API}/api/v1/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: API },
  body: JSON.stringify({ email, password: randomBytes(18).toString('base64url'), name: 'Smoke tester' }),
});
if (!signup.ok) throw new Error(`Could not create the throwaway account: ${signup.status} ${await signup.text()}`);
const session = signup.headers.get('set-auth-token');
const call = async (method, path, body) => {
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}' });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};
const must = (r, ok, what) => {
  if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
};
const para = (text) => [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];

say('Creating a throwaway workspace, an agent that runs on "Your own AI", and a lead');
const ws = must(await call('POST', '/workspaces', { name: 'Runner smoke test' }), [201], 'workspace').id;
const ensured = must(await call('POST', `/workspaces/${ws}/agents/ensure`), [200, 201], 'agents/ensure');
const agentsDb = ensured.agentsDb.id;
const runsDb = ensured.runsDb.id;
const option = (db, field, label) => sql(`select o.id from select_options o join fields f on f.id=o.field_id where f.database_id='${db}' and f.api_name='${field}' and o.label='${label}'`);
const spaceId = (await call('GET', `/workspaces/${ws}/spaces`)).json[0].id;
const leadsDb = must(await call('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Leads' }), [201], 'database').id;
const agent = must(
  await call('POST', `/workspaces/${ws}/databases/${agentsDb}/records`, {
    values: {
      name: 'Smoke test assistant',
      enabled: true,
      ai_mode: option(agentsDb, 'ai_mode', 'Your own AI'),
      scopes: [option(agentsDb, 'scopes', 'write')],
      instructions: para('You are a sales assistant. Read the lead record you were woken for. Then add one comment on that record saying in one sentence what the lead is and what you would do next. That comment is your hand-off. Do nothing else.'),
    },
  }),
  [201],
  'agent',
).id;

say('Pairing the Runner (the same steps a person takes, through the API)');
// ONE directory for everything this run creates. Cleanup removes ONLY what is tracked under it, never anything that merely looks like it.
const run = createRunDir();
const home = run.track(run.path('runner-home'));
console.log(`This run's own directory (the only thing it will ever delete): ${run.root}`);
const env = { ...process.env, STORYOS_RUNNER_HOME: home };
const code = must(await call('POST', `/workspaces/${ws}/runners/pairing-codes`), [200, 201], 'pairing code').code;
const pair = spawn('node', [RUNNER, 'pair', code, '--server', API, '--mcp-url', MCP], { env, stdio: 'inherit' });
run.trackProcess(pair);
const runner = await until(async () => (await call('GET', `/workspaces/${ws}/runners`)).json.data?.[0], 'the Runner to appear');
console.log(`Tools the Runner found on this computer: ${runner.tools.map((t) => `${t.id}${t.installed ? '' : ' (missing)'}${t.logged_in === true ? ' signed in' : ''}`).join(', ')}`);
must(await call('POST', `/workspaces/${ws}/runners/${runner.id}/activate`, { tool: 'claude-code' }), [200], 'activate (is claude installed?)');
await until(() => pair.exitCode !== null, 'the pair command to finish');
must(await call('PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id }), [200], 'assign the agent to the Runner');

say('Starting the Runner. Its log is printed below; nothing secret is in it.');
const start = spawn('node', [RUNNER, 'start'], { env, stdio: 'inherit' });
run.trackProcess(start);

say('Handing a lead to the agent');
const lead = must(await call('POST', `/workspaces/${ws}/databases/${leadsDb}/records`, { values: { name: 'Acme Corp asked for a quote for 40 seats' } }), [201], 'lead').id;
must(await call('POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: lead }), [201], 'delegate');

const finished = await until(() => /^(done|failed|canceled)$/.test(sql(`select status from agent_wakes where record_id='${lead}'`)) || /queued/.test(sql(`select status||coalesce(not_before::text,'') from agent_wakes where record_id='${lead}' and not_before > now() + interval '1 minute'`)), 'the wake to finish', WAIT_MS).catch(() => false);
start.kill('SIGTERM');
await sleep(500);

say('What happened');
const wake = sql(`select 'wake status: '||status||', attempts: '||attempts||coalesce(', not before: '||not_before::text,'') from agent_wakes where record_id='${lead}'`);
console.log(finished ? wake : `${wake}  (it had not finished after ${WAIT_MS / 60000} minutes)`);
const runId = sql(`select run_id from agent_wakes where record_id='${lead}'`);
if (runId) {
  const field = (name) => sql(`select f.id from fields f where f.database_id='${runsDb}' and f.api_name='${name}'`);
  const val = (name) => sql(`select coalesce(values->>'${field(name)}','') from records where id='${runId}'`);
  console.log(`run record: runner="${val('runner')}" tool_version="${val('tool_version')}" tokens_in=${val('tokens_in') || 'not reported'} tokens_out=${val('tokens_out') || 'not reported'} session_id=${val('session_id') || 'none'}`);
  console.log(`run summary: ${val('summary').slice(0, 400) || '(none)'}`);
}
console.log(sql(`select coalesce(string_agg('comment by '||coalesce(agent_name,'a person')||' (source '||source::text||'): '||left(body::text,300), E'\\n'), 'NO COMMENT ON THE LEAD') from comments where record_id='${lead}' and agent_name is not null`));
console.log(`\nWorkspace ${ws} stays in your local database.`);
if (process.env.SMOKE_KEEP === '1' || !finished) {
  console.log(`Kept for you to read: ${join(home, 'logs', 'runner.log')}\nWhen done, delete ONLY this directory (copy the exact path above): ${run.root}`);
} else {
  const report = run.cleanup();
  console.log(`Cleaned up only what this run created: ${report.deleted.join(', ')}${report.refused.length ? `; REFUSED (outside this run): ${report.refused.join(', ')}` : ''}`);
}
process.exit(finished ? 0 : 1);
