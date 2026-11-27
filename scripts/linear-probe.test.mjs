import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PREDICTIONS, QUERIES, runProbe } from './linear-probe.mjs';

/**
 * Ticket #1367 — the Linear probe. The Linear side here is a DOCUMENTED-SHAPE fake (hand-written from Linear's published schema, not a
 * capture): it proves the probe's own guarantees (read-only, key never printed, one host, no StoryOS) and that it prints a verdict next
 * to each prediction. What Linear really returns is exactly what running the probe with a key is for.
 */
const KEY = 'lin_api_SECRETSECRETSECRET';

function fakeLinear({ onRequest, failWith } = {}) {
  const seen = [];
  const issues = Array.from({ length: 120 }, (_, i) => ({
    id: `i${i}`, identifier: `ISSUE-${i + 2}`, number: i + 2,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-02-01T00:00:00.000Z', startedAt: i % 2 ? null : '2025-01-05T00:00:00.000Z', completedAt: null, dueDate: null,
    state: { name: i % 3 ? 'Todo' : 'Duplicate', type: i % 3 ? 'unstarted' : 'canceled' },
    assignee: i % 4 === 0 ? { email: i % 8 === 0 ? 'a@x.test' : null } : null,
  }));
  const page = (all, query, variables) => {
    const first = Number(query.match(/first: (\d+)/)?.[1] ?? 50);
    const start = Number(variables.after ?? 0);
    const nodes = all.slice(start, start + first);
    return { nodes, pageInfo: { hasNextPage: start + nodes.length < all.length, endCursor: String(start + nodes.length) } };
  };
  const fetchFn = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    seen.push({ url, auth: init.headers.authorization, query });
    onRequest?.(url, init);
    if (failWith) throw new Error(`socket hang up while sending ${init.headers.authorization}`);
    const op = query.match(/^\s*query (\w+)/)?.[1];
    const respond = (data, complexity = 321) => ({ ok: true, status: 200, headers: { get: (h) => (h === 'x-complexity' ? String(complexity) : null) }, json: async () => ({ data }) });
    switch (op) {
      case 'Teams': return respond({ teams: { nodes: [{ id: 't1', key: 'ISSUE', name: 'Engineering', private: false }, { id: 't2', key: 'KYIV', name: 'Kyiv', private: true }], pageInfo: { hasNextPage: false, endCursor: null } } });
      case 'TeamIssueCount': return respond({ team: { issueCount: 120 } });
      case 'TeamStates': return respond({ team: { states: page([{ id: 's1', name: 'Todo', type: 'unstarted', position: 1 }, { id: 's2', name: 'Duplicate', type: 'canceled', position: 2 }], query, variables) } });
      case 'ProbeWalk': return respond({ team: { issues: page(issues, query, variables) } });
      case 'TeamIssues': return respond({ team: { issues: page([], query, variables) } }, 4800);
      case 'TeamComments': return respond({ comments: page([], query, variables) });
      case 'TeamIssueHistory': {
        const entries = (i) => [
          { id: `h${i.id}`, createdAt: '2025-01-02T00:00:00.000Z', actor: { id: 'u', name: 'Ada', email: 'a@x.test' }, fromState: { name: 'Todo' }, toState: { name: 'Done' } },
          { id: `e${i.id}`, createdAt: '2025-01-03T00:00:00.000Z', actor: null, fromState: null, toState: null },
        ];
        const withHistory = issues.map((i) => ({ id: i.id, history: { nodes: entries(i), pageInfo: { hasNextPage: false, endCursor: null } } }));
        return respond({ team: { issues: page(withHistory, query, variables) } }, 9100);
      }
      case 'TeamMembers': return respond({ team: { members: page([{ id: 'm', name: 'Kate', email: 'k@x.test', active: true }], query, variables) } });
      case 'ProbeUsers': return respond({ users: page([{ id: 'u', email: 'a@x.test', active: true }], query, variables) });
      case 'ProbeProjects': return respond({ projects: page([{ id: 'p', teams: { nodes: [{ key: 'ISSUE' }, { key: 'SF' }] } }], query, variables) });
      case 'ProbeMilestones': return respond({ projectMilestones: page([{ id: 'ms' }], query, variables) });
      default: throw new Error(`fake Linear: unrecognised ${query.slice(0, 40)}`);
    }
  };
  return { fetchFn, seen };
}

test('read-only, one host, the key only in the authorization header, and never a StoryOS call', async () => {
  const lines = [];
  const { fetchFn, seen } = fakeLinear();
  await runProbe({ apiKey: KEY, fetchFn, out: (l) => lines.push(l) });
  assert.ok(seen.length > 10);
  for (const r of seen) {
    assert.equal(r.url, 'https://api.linear.app/graphql');
    assert.equal(r.auth, KEY);
    assert.doesNotMatch(r.query, /^\s*mutation\b/i);
    assert.doesNotMatch(r.query, /\bmutation\s*[({]/i);
  }
  assert.ok(!lines.join('\n').includes(KEY), 'the key is never printed');
});

test('a failure that carries the key in its message is scrubbed before it is printed or thrown', async () => {
  const lines = [];
  const { fetchFn } = fakeLinear({ failWith: true });
  await assert.rejects(runProbe({ apiKey: KEY, fetchFn, out: (l) => lines.push(l) }), (e) => {
    assert.ok(!String(e.message).includes(KEY));
    assert.match(e.message, /\[key\]/);
    return true;
  });
  assert.ok(!lines.join('\n').includes(KEY));
});

test('it prints a verdict next to each prediction: OK when Linear agrees, DIFFERS with both numbers when it does not', async () => {
  const lines = [];
  const { fetchFn } = fakeLinear();
  await runProbe({ apiKey: KEY, fetchFn, out: (l) => lines.push(l), teams: ['ISSUE'] });
  const text = lines.join('\n');
  assert.match(text, new RegExp(`issue count: DIFFERS \\(predicted ${PREDICTIONS.ISSUE.issues}, measured 120\\)`));
  assert.match(text, /first number: OK/);
  assert.match(text, /last number: DIFFERS/);
  assert.match(text, /"Duplicate" state type from Linear: "canceled"/);
  assert.match(text, /importer issue page \(50 issues, nested labels\): complexity 4800/);
  assert.match(text, /importer history page \(25 issues x 50 history\): complexity 9100/);
  assert.match(text, /history sample: 25 issues, 50 entries, 25 state changes/);
});

test('a team key that is not visible is reported; a private team shows as private and its members are counted', async () => {
  const lines = [];
  const { fetchFn } = fakeLinear();
  await runProbe({ apiKey: KEY, fetchFn, out: (l) => lines.push(l), teams: ['ISSUE', 'KYIV', 'GONE'] });
  const text = lines.join('\n');
  assert.match(text, /KYIV\s+PRIVATE/);
  assert.match(text, /NOT visible to this key: GONE/);
  assert.match(text, /members: 1 \(1 active\); email returned for 1 of 1/);
});

test('an assignee with no email is called out, because members are matched by email', async () => {
  const lines = [];
  const { fetchFn } = fakeLinear();
  await runProbe({ apiKey: KEY, fetchFn, out: (l) => lines.push(l), teams: ['ISSUE'] });
  assert.match(lines.join('\n'), /assignee email returned for 15 of 30/);
});

test('it says what it did not probe, so an unprobed area cannot read as a cleared one', async () => {
  const lines = [];
  const { fetchFn } = fakeLinear();
  await runProbe({ apiKey: KEY, fetchFn, out: (l) => lines.push(l), teams: ['ISSUE'] });
  const text = lines.join('\n');
  assert.match(text, /Not probed by this script/);
  assert.match(text, /relations .* attachments, documents/);
});

test('a probe that cannot run is printed as NOT PROBED and the rest still run', async () => {
  const lines = [];
  const base = fakeLinear();
  const fetchFn = async (url, init) => {
    if (JSON.parse(init.body).query.includes('ProbeUsers')) return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) };
    return base.fetchFn(url, init);
  };
  const result = await runProbe({ apiKey: KEY, fetchFn, out: (l) => lines.push(l), teams: ['ISSUE'] });
  assert.match(lines.join('\n'), /NOT PROBED: users — Linear API 403 on users — the key is wrong or lacks read scope/);
  assert.match(lines.join('\n'), /project milestones: 1/);
  assert.equal(result.notProbed.length, 1);
});

test('the script reads only LINEAR_API_KEY from the environment and knows no StoryOS address', () => {
  const src = readFileSync(new URL('./linear-probe.mjs', import.meta.url), 'utf8');
  const envReads = [...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)], ['LINEAR_API_KEY']);
  assert.doesNotMatch(src, /storyos\.dev|\/api\/v1|STORYOS_/i);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /process\.argv\[\d\].*(key|token)/i);
});

test('it refuses to run without a key, and a key given as an argument is not accepted', async () => {
  await assert.rejects(runProbe({ apiKey: undefined, fetchFn: async () => { throw new Error('must not call'); } }), /LINEAR_API_KEY is not set/);
  assert.ok(typeof QUERIES.teamIssues === 'string');
});
