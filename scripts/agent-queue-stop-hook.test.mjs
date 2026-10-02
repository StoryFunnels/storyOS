// Tests for scripts/agent-queue-stop-hook.sh (#340). Run: node --test scripts/
//
// The script runs as a real subprocess against a local stub API, so what is
// exercised is the actual bash + jq + curl, not a model of it. What a stub
// CANNOT prove — that Claude Code honours the block/allow protocol, and that a
// session really works several tickets — is covered by the real-session run
// recorded on the ticket, not here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'agent-queue-stop-hook.sh');
const WS = 'ws-1';
const DB = 'db-1';
const AGENT = 'agent-marek';
const TOKEN = 'mn_pat_test_token';
const OPT = { todo: 'opt-todo', inprogress: 'opt-inprogress', done: 'opt-done', low: 'p-low', medium: 'p-med', high: 'p-high', urgent: 'p-urgent' };

let server;
let port;
let hits;
let lastQueryBody;
let lastAuth;
let queryStatus;
let dbStatus;
let rows;

const DB_DEF = {
  fields: [
    { apiName: 'state', options: [{ id: OPT.todo, label: 'ToDo' }, { id: OPT.inprogress, label: 'In Progress' }, { id: OPT.done, label: 'Done' }] },
    { apiName: 'priority', options: [{ id: OPT.low, label: 'Low' }, { id: OPT.medium, label: 'Medium' }, { id: OPT.high, label: 'High' }, { id: OPT.urgent, label: 'Urgent' }] },
  ],
};

// Applies the one filter shape the hook sends, so a human:true / Done / other-
// agent row is genuinely excluded by the query rather than by the test's setup.
function matches(row, node) {
  if (node.and) return node.and.every((n) => matches(row, n));
  const v = row.values[node.field];
  switch (node.op) {
    case 'has': return Array.isArray(v) ? v.some((x) => node.value.includes(x.id ?? x)) : node.value.includes(v);
    case 'eq': return v === node.value;
    case 'not_empty': return typeof v === 'string' ? v.length > 0 : v != null;
    default: throw new Error(`stub: unsupported op ${node.op}`);
  }
}

function row(number, o = {}) {
  return {
    number,
    title: o.title ?? `Ticket ${number}`,
    created_at: o.created_at ?? `2026-09-${String(10 + (number % 18)).padStart(2, '0')}T00:00:00Z`,
    updated_at: o.updated_at ?? '2026-10-01T00:00:00Z',
    values: {
      priority: o.priority ?? OPT.medium,
      state: o.state ?? OPT.todo,
      human: o.human ?? false,
      agents: [{ id: o.agent ?? AGENT }],
      acceptance_criteria: o.ac ?? 'something',
    },
  };
}

before(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    lastAuth = req.headers.authorization;
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && req.url === `/api/v1/workspaces/${WS}/databases/${DB}`) {
        return dbStatus === 200 ? send(200, DB_DEF) : send(dbStatus, { error: { message: 'db down' } });
      }
      if (req.method === 'POST' && req.url === `/api/v1/workspaces/${WS}/databases/${DB}/records/query`) {
        lastQueryBody = JSON.parse(buf);
        if (queryStatus !== 201) return send(queryStatus, { error: { message: 'boom' } });
        return send(201, { data: rows.filter((r) => matches(r, lastQueryBody.filter)) });
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

function reset() {
  hits = 0;
  lastQueryBody = undefined;
  lastAuth = undefined;
  queryStatus = 201;
  dbStatus = 200;
  rows = [];
}

function run({ sid = 'sess-1', state, env = {}, optIn = true, stdin } = {}) {
  const base = {
    PATH: process.env.PATH,
    STORYOS_TOKEN: TOKEN,
    STORYOS_QUEUE_API: `http://127.0.0.1:${port}/api/v1`,
    STORYOS_QUEUE_WS: WS,
    STORYOS_QUEUE_DB: DB,
    STORYOS_QUEUE_AGENT: AGENT,
    STORYOS_QUEUE_STATE_DIR: state,
    ...(optIn ? { STORYOS_QUEUE_HOOK: 'drain' } : {}),
    ...env,
  };
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT], { env: base });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let json = null;
      try { json = out.trim() ? JSON.parse(out) : null; } catch { /* leave null */ }
      resolve({ code, out, err, json });
    });
    child.stdin.end(stdin ?? JSON.stringify({ session_id: sid, stop_hook_active: false }));
  });
}

const newState = () => mkdtempSync(join(tmpdir(), 'qhook-'));
const blocked = (r) => r.json?.decision === 'block';

test('inert unless the session opted in — and then it never touches the network', async () => {
  reset();
  const r = await run({ state: newState(), optIn: false });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(hits, 0);
});

test('an empty curated queue is a clean, visible stop', async () => {
  reset();
  rows = [];
  const r = await run({ state: newState() });
  assert.equal(r.code, 0);
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /queue empty/i);
});

test('a non-empty queue blocks with the highest-priority, oldest ticket as the work order', async () => {
  reset();
  rows = [
    row(10, { priority: OPT.high, created_at: '2026-09-01T00:00:00Z' }),
    row(11, { priority: OPT.urgent, created_at: '2026-09-20T00:00:00Z', title: 'The urgent one' }),
    row(12, { priority: OPT.urgent, created_at: '2026-09-05T00:00:00Z', title: 'Older urgent' }),
  ];
  const state = newState();
  const r = await run({ state });
  assert.equal(r.code, 0);
  assert.ok(blocked(r));
  assert.match(r.json.reason, /NEXT: #12 — Older urgent\s+\[Urgent\]/);
  assert.match(r.json.reason, /3 ticket\(s\) in your queue/);
});

test('the work order carries the guardrails and the way out, not just "keep working"', async () => {
  reset();
  rows = [row(1)];
  const state = newState();
  const r = await run({ state, sid: 'abc' });
  for (const needle of [/human:true/, /MOVE it out of your queue/, /drizzle migration/, /live browser/, /Builders do not merge/, /premise against origin\/main/]) {
    assert.match(r.json.reason, needle);
  }
  assert.ok(r.json.reason.includes(join(state, 'abc.stop')), 'names the stop sentinel for this session');
});

test('the queue is a curated filter, sent with the token — never "all open tickets"', async () => {
  reset();
  rows = [row(1)];
  await run({ state: newState() });
  assert.equal(lastAuth, `Bearer ${TOKEN}`);
  assert.deepEqual(lastQueryBody.filter.and, [
    { field: 'agents', op: 'has', value: [AGENT] },
    { field: 'state', op: 'has', value: [OPT.todo, OPT.inprogress] },
    { field: 'human', op: 'eq', value: false },
    { field: 'acceptance_criteria', op: 'not_empty' },
  ]);
});

test('human:true, done, other-agent and no-acceptance-criteria tickets are never offered', async () => {
  reset();
  rows = [
    row(1, { human: true, priority: OPT.urgent, title: 'founder decision' }),
    row(2, { state: OPT.done, priority: OPT.urgent }),
    row(3, { agent: 'agent-someone-else', priority: OPT.urgent }),
    row(4, { ac: '', priority: OPT.urgent }),
    row(5, { priority: OPT.low, title: 'the only eligible one' }),
  ];
  const r = await run({ state: newState() });
  assert.ok(blocked(r));
  assert.match(r.json.reason, /NEXT: #5 — the only eligible one/);
  assert.match(r.json.reason, /1 ticket\(s\) in your queue/);
  assert.doesNotMatch(r.json.reason, /founder decision/);
});

test('with only human:true work in range the queue reads as empty', async () => {
  reset();
  rows = [row(1, { human: true })];
  const r = await run({ state: newState() });
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /queue empty/i);
});

test('FAILS OPEN — query error, database error, unreachable API, bad stdin, missing config', async () => {
  reset();
  rows = [row(1)];

  queryStatus = 500;
  let r = await run({ state: newState() });
  assert.equal(r.code, 0);
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /HTTP 500/);

  reset();
  dbStatus = 503;
  r = await run({ state: newState() });
  assert.equal(r.code, 0);
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /HTTP 503/);

  reset();
  r = await run({ state: newState(), env: { STORYOS_QUEUE_API: 'http://127.0.0.1:1/api/v1' } });
  assert.equal(r.code, 0);
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /could not reach the API/);

  r = await run({ state: newState(), stdin: 'not json' });
  assert.equal(r.code, 0);
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /not JSON|session_id/);

  r = await run({ state: newState(), env: { STORYOS_QUEUE_DB: '' } });
  assert.equal(r.code, 0);
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /missing config: STORYOS_QUEUE_DB/);
});

test('the counter is per session: the cap stops one session, a fresh one starts at zero', async () => {
  reset();
  // Distinct tickets, so only the CAP — not the stuck rule — can be what stops us.
  rows = [row(1, { priority: OPT.urgent }), row(2, { priority: OPT.high }), row(3, { priority: OPT.low })];
  const state = newState();
  const env = { STORYOS_QUEUE_CAP: '2' };
  assert.ok(blocked(await run({ state, sid: 'A', env })));
  assert.ok(blocked(await run({ state, sid: 'A', env })));
  const capped = await run({ state, sid: 'A', env });
  assert.equal(blocked(capped), false);
  assert.match(capped.json.systemMessage, /cap of 2/);
  // a different session id shares the state dir and the queue — and is not capped
  assert.ok(blocked(await run({ state, sid: 'B', env })));
});

test('nothing left I can ACT on: an unchanged ticket offered N times ends the loop instead of cycling', async () => {
  reset();
  rows = [row(7, { updated_at: '2026-10-01T10:00:00Z' })];
  const state = newState();
  const env = { STORYOS_QUEUE_RETRIES: '2' };
  assert.ok(blocked(await run({ state, env })));
  assert.ok(blocked(await run({ state, env })));
  const done = await run({ state, env });
  assert.equal(blocked(done), false);
  assert.match(done.json.systemMessage, /nothing left I can act on/i);
  assert.match(done.json.systemMessage, /#7/);
});

test('a stuck ticket is skipped in favour of the next one; progress on it resets the count', async () => {
  reset();
  rows = [row(7, { priority: OPT.urgent, updated_at: 'T1' }), row(8, { priority: OPT.low })];
  const state = newState();
  const env = { STORYOS_QUEUE_RETRIES: '1' };
  let r = await run({ state, env });
  assert.match(r.json.reason, /NEXT: #7/);
  r = await run({ state, env });
  assert.match(r.json.reason, /NEXT: #8/, '#7 was offered once with no change, so #8 is next');
  assert.match(r.json.reason, /skipped as stuck: #7/);
  // the agent edited #7: a new updated_at is progress, so it is offerable again
  rows[0].updated_at = 'T2';
  r = await run({ state, env });
  assert.match(r.json.reason, /NEXT: #7/);
});

test('an explicit stop sentinel ends the session with its reason, without asking the API', async () => {
  reset();
  rows = [row(1)];
  const state = newState();
  writeFileSync(join(state, 'sess-9.stop'), 'blocked on Vasya joining the workspace');
  const r = await run({ state, sid: 'sess-9' });
  assert.equal(blocked(r), false);
  assert.match(r.json.systemMessage, /blocked on Vasya/);
  assert.equal(hits, 0);
});

test('a hostile session_id cannot write outside the state dir', async () => {
  reset();
  rows = [row(1)];
  const parent = newState();
  const state = join(parent, 'state');
  const r = await run({ state, sid: '../../escape' });
  assert.ok(blocked(r));
  assert.deepEqual(readdirSync(parent), ['state']);
  assert.ok(!existsSync(join(parent, 'escape.count')));
  rmSync(parent, { recursive: true, force: true });
});
