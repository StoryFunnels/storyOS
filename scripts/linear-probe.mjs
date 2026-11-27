#!/usr/bin/env node
/**
 * Ticket #1367 (step 0 of the plan on ticket #1362) — the READ-ONLY probe of Linear that has to run before the first real import.
 *
 * The importer was built against Linear's published GraphQL schema and hand-written fixtures; nothing in it has met the real API. This script
 * is what changes that. With a Linear API key it counts what Linear actually holds (teams, issues, identifiers, dates, states, people),
 * measures what the importer's own queries cost, and prints each fact next to what the live StoryOS mirror predicted, so a surprise is a
 * line that says DIFFERS rather than something found during the import.
 *
 *   LINEAR_API_KEY=lin_api_... node scripts/linear-probe.mjs [--teams ISSUE,SF] [--history-sample 25]
 *
 * Guarantees, each tested in scripts/linear-probe.test.mjs:
 *  - the key is read from the environment ONLY (never an argument, a file or a prompt), is sent only to https://api.linear.app/graphql,
 *    and is never printed: every line of output is scrubbed of it, error messages included.
 *  - it is READ-ONLY toward Linear (queries only, no mutation) and never talks to StoryOS at all: no StoryOS URL, token or database.
 *  - what it did not probe is printed at the end, so an unprobed area cannot read as a cleared one.
 */
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.linear.app/graphql';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

/**
 * The importer's own queries, copied from apps/api/src/integrations/linear.service.ts so the cost measured here is the cost the import will
 * pay. apps/api/test/linear-probe-queries.test.ts fails if either side changes without the other.
 */
export const QUERIES = {
  teams: `query Teams($after: String) { teams(first: 50, after: $after) { nodes { id key name private } ${PAGE_INFO} } }`,
  teamIssues: `query TeamIssues($id: String!, $after: String) {
  team(id: $id) {
    issues(first: 50, after: $after) {
      nodes {
        id identifier number title description url estimate priority
        createdAt updatedAt startedAt completedAt dueDate
        state { type name }
        labels(first: 50) { nodes { id name color } ${PAGE_INFO} }
        assignee { id name email }
        parent { id }
        cycle { id }
        project { id }
        projectMilestone { id }
      }
      ${PAGE_INFO}
    }
  }
}`,
  teamIssueHistory: `query TeamIssueHistory($id: String!, $after: String) {
  team(id: $id) {
    issues(first: 25, after: $after) {
      nodes { id history(first: 50) { nodes { id createdAt actor { id name email } fromState { name } toState { name } } ${PAGE_INFO} } }
      ${PAGE_INFO}
    }
  }
}`,
  teamComments: `query TeamComments($id: ID!, $after: String) { comments(first: 100, after: $after, filter: { issue: { team: { id: { eq: $id } } } }) { nodes { id body createdAt url user { id name email } botActor { name } externalUser { name email } issue { id } } ${PAGE_INFO} } }`,
  teamMembers: `query TeamMembers($id: String!, $after: String) { team(id: $id) { members(first: 100, after: $after) { nodes { id name email active } ${PAGE_INFO} } } }`,
  teamStates: `query TeamStates($id: String!, $after: String) { team(id: $id) { states(first: 100, after: $after) { nodes { id name type position } ${PAGE_INFO} } } }`,
  teamIssueCount: `query TeamIssueCount($id: String!) { team(id: $id) { issueCount } }`,
  // The probe's own lighter walk: every issue, only the columns the facts below need. Not an importer query.
  walkIssues: `query ProbeWalk($id: String!, $after: String) { team(id: $id) { issues(first: 100, after: $after) { nodes { id identifier number createdAt updatedAt startedAt completedAt dueDate state { name type } assignee { email } } ${PAGE_INFO} } } }`,
  users: `query ProbeUsers($after: String) { users(first: 100, after: $after, includeDisabled: true) { nodes { id email active } ${PAGE_INFO} } }`,
  projects: `query ProbeProjects($after: String) { projects(first: 100, after: $after) { nodes { id teams { nodes { key } } } ${PAGE_INFO} } }`,
  milestones: `query ProbeMilestones($after: String) { projectMilestones(first: 100, after: $after) { nodes { id } ${PAGE_INFO} } }`,
};

/**
 * What the live StoryOS mirror predicted (read-only, 2026-11-26, plan on ticket #1362). These are PREDICTIONS about Linear, taken from the
 * mirror, not facts about it: the whole point of the probe is to say which of them hold. Identifiers per team are the only ones the mirror
 * can speak to before a real import.
 */
export const PREDICTIONS = {
  ISSUE: { issues: 5309, minNumber: 2, maxNumber: 5496, hasNoCategoryState: 'Duplicate', distinctStates: 19 },
  SF: { issues: 808, minNumber: 6, maxNumber: 1094 },
  note: 'SF: 819 mirrored records, 11 of them hand-made, so 808 imported. ISSUE gaps = (max - min + 1) - issues, which the figures above make 186, not the 187 the plan quoted.',
};

/** How many issues' history is sampled by default: enough to prove the shape and measure cost, not a second full walk. */
const DEFAULT_HISTORY_SAMPLE = 25;

function makeClient({ fetchFn, apiKey, out }) {
  const scrub = (text) => String(text).split(apiKey).join('[key]');
  const log = (line = '') => out(scrub(line));
  const complexities = new Map();
  /** One GraphQL call. Returns { data, complexity }. Throws a scrubbed error; never includes the key. */
  async function gql(kind, query, variables = {}) {
    if (/^\s*mutation\b/i.test(query)) throw new Error('refusing to send a mutation: this probe is read-only');
    let res;
    try {
      res = await fetchFn(ENDPOINT, { method: 'POST', headers: { authorization: apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    } catch (e) {
      throw new Error(scrub(`network error calling Linear: ${e instanceof Error ? e.message : e}`));
    }
    const complexity = Number(res.headers?.get?.('x-complexity'));
    if (Number.isFinite(complexity)) complexities.set(kind, Math.max(complexities.get(kind) ?? 0, complexity));
    if (!res.ok) throw new Error(`Linear API ${res.status} on ${kind}${res.status === 401 || res.status === 403 ? ' — the key is wrong or lacks read scope' : ''}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(scrub(`Linear API on ${kind}: ${body.errors[0].message}`));
    return { data: body.data, complexity: Number.isFinite(complexity) ? complexity : null };
  }
  async function pageAll(kind, query, variables, pick, { max = Infinity } = {}) {
    const rows = [];
    let after;
    for (;;) {
      const { data } = await gql(kind, query, after ? { ...variables, after } : variables);
      const conn = pick(data);
      if (!conn || !Array.isArray(conn.nodes)) throw new Error(`Linear returned no ${kind} list`);
      rows.push(...conn.nodes);
      if (!conn.pageInfo?.hasNextPage || rows.length >= max) return rows;
      after = conn.pageInfo.endCursor;
      if (!after) throw new Error(`Linear paging for ${kind} stopped advancing`);
    }
  }
  return { gql, pageAll, log, complexities };
}

const verdict = (predicted, measured) => (predicted === measured ? 'OK' : `DIFFERS (predicted ${predicted}, measured ${measured})`);
const pct = (n, of) => (of === 0 ? '0' : `${n} of ${of}`);

/**
 * Run every probe and print the findings through `out`. Never throws for a single failing probe: a probe that cannot run is printed as
 * "NOT PROBED: <why>" and the rest continue, because the facts that did come back are still worth having.
 */
export async function runProbe({ apiKey, fetchFn = fetch, out = console.log, teams: wanted = [], historySample = DEFAULT_HISTORY_SAMPLE }) {
  if (!apiKey) throw new Error('LINEAR_API_KEY is not set (it is read from the environment only)');
  const { gql, pageAll, log, complexities } = makeClient({ fetchFn, apiKey, out });
  const notProbed = [];
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log(`  NOT PROBED: ${label} — ${why}`);
      notProbed.push(`${label} (${why})`);
      return null;
    }
  };

  log('Linear probe — read-only. Findings are Linear\'s answers to this key, next to what the StoryOS mirror predicted.');
  log('');
  log('== Teams');
  const allTeams = await pageAll('teams', QUERIES.teams, {}, (d) => d.teams);
  const chosen = wanted.length > 0 ? allTeams.filter((t) => wanted.includes(t.key)) : allTeams;
  log(`  teams visible to this key: ${allTeams.length} (${allTeams.filter((t) => t.private).length} private)`);
  for (const t of allTeams) log(`    ${t.key.padEnd(8)} ${t.private ? 'PRIVATE' : 'public '} ${t.name}`);
  const missing = wanted.filter((k) => !allTeams.some((t) => t.key === k));
  if (missing.length > 0) log(`  asked for but NOT visible to this key: ${missing.join(', ')} (a typo, or a private team the key's user is not in; the importer would skip them)`);
  log('  (Linear only returns private teams the key\'s own user belongs to; a private team missing from this list cannot be told from one that does not exist.)');

  const summary = { teams: {} };
  for (const team of chosen) {
    log('');
    log(`== Team ${team.key} (${team.name})${team.private ? ' — PRIVATE' : ''}`);
    const t = { issues: 0 };
    summary.teams[team.key] = t;

    await attempt('issue total', async () => {
      const { data } = await gql('teamIssueCount', QUERIES.teamIssueCount, { id: team.id });
      t.total = data.team.issueCount;
      log(`  Team.issueCount: ${t.total}`);
    });

    const states = await attempt('workflow states', async () => pageAll('teamStates', QUERIES.teamStates, { id: team.id }, (d) => d.team.states));
    if (states) {
      log(`  workflow states: ${states.length} — ${states.map((s) => `${s.name} [${s.type}]`).join(', ')}`);
      const p = PREDICTIONS[team.key];
      if (p?.distinctStates !== undefined) log(`    distinct state names: ${verdict(p.distinctStates, states.length)}`);
      if (p?.hasNoCategoryState) {
        const dup = states.find((s) => s.name === p.hasNoCategoryState);
        log(`    "${p.hasNoCategoryState}" state type from Linear: ${dup ? `"${dup.type}"` : 'NO SUCH STATE'} (the mirror holds this one with no category; a type here that the importer does not map would explain it)`);
      }
    }

    const issues = await attempt('issue walk', async () => pageAll('walkIssues', QUERIES.walkIssues, { id: team.id }, (d) => d.team.issues));
    if (issues) {
      t.issues = issues.length;
      const numbers = issues.map((i) => i.number).filter((n) => Number.isInteger(n));
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      const identOk = issues.filter((i) => i.identifier === `${team.key}-${i.number}`).length;
      log(`  issues walked: ${issues.length}${t.total !== undefined ? ` — ${t.total === issues.length ? 'matches' : 'DIFFERS from'} Team.issueCount ${t.total}` : ''}`);
      log(`  identifiers: ${team.key}-${min} .. ${team.key}-${max}, ${(max - min + 1) - issues.length} gaps; identifier == "${team.key}-<number>" for ${pct(identOk, issues.length)}`);
      const p = PREDICTIONS[team.key];
      if (p) {
        log(`    issue count: ${verdict(p.issues, issues.length)}; first number: ${verdict(p.minNumber, min)}; last number: ${verdict(p.maxNumber, max)}`);
      }
      const has = (k) => issues.filter((i) => i[k] !== null && i[k] !== undefined).length;
      log(`  dates present: createdAt ${pct(has('createdAt'), issues.length)}, updatedAt ${pct(has('updatedAt'), issues.length)}, startedAt ${pct(has('startedAt'), issues.length)}, completedAt ${pct(has('completedAt'), issues.length)}, dueDate ${pct(has('dueDate'), issues.length)}`);
      const oldest = issues.map((i) => i.createdAt).filter(Boolean).sort()[0];
      const newest = issues.map((i) => i.createdAt).filter(Boolean).sort().at(-1);
      log(`  created between ${oldest ?? '?'} and ${newest ?? '?'} (the mirror's created_at is the IMPORT date, 2026-10-15 to 2026-11-26)`);
      const byState = new Map();
      for (const i of issues) byState.set(`${i.state.name} [${i.state.type}]`, (byState.get(`${i.state.name} [${i.state.type}]`) ?? 0) + 1);
      log(`  issues per state: ${[...byState].map(([k, v]) => `${k} ${v}`).join(', ')}`);
      const assigned = issues.filter((i) => i.assignee);
      const withEmail = assigned.filter((i) => i.assignee.email);
      log(`  assigned: ${assigned.length}; assignee email returned for ${pct(withEmail.length, assigned.length)} of them${assigned.length > 0 && withEmail.length === 0 ? '  <-- NO emails: members cannot be matched by email with this key' : ''}`);
      log(`  distinct assignee emails: ${new Set(withEmail.map((i) => i.assignee.email.toLowerCase())).size}`);
    }

    // The importer's own queries, one page each, for their cost. Linear refuses a query that is too complex, so a page that fails here is a page the import cannot read.
    await attempt('importer issue page cost', async () => {
      const { complexity } = await gql('teamIssues', QUERIES.teamIssues, { id: team.id });
      log(`  importer issue page (50 issues, nested labels): complexity ${complexity ?? 'not reported'}`);
    });
    await attempt('importer comment page cost', async () => {
      const { complexity } = await gql('teamComments', QUERIES.teamComments, { id: team.id });
      log(`  importer comment page (100 comments): complexity ${complexity ?? 'not reported'}`);
    });
    await attempt('issue history', async () => {
      const rows = await pageAll('teamIssueHistory', QUERIES.teamIssueHistory, { id: team.id }, (d) => d.team.issues, { max: historySample });
      const sample = rows.slice(0, historySample);
      const entries = sample.flatMap((i) => i.history.nodes);
      const stateChanges = entries.filter((e) => e.toState);
      const longest = Math.max(0, ...sample.map((i) => i.history.nodes.length));
      const overflow = sample.filter((i) => i.history.pageInfo?.hasNextPage).length;
      log(`  history sample: ${sample.length} issues, ${entries.length} entries, ${stateChanges.length} state changes (toState set), longest first page ${longest}, ${overflow} with more than 50 entries`);
      log(`    state changes with an actor: ${pct(stateChanges.filter((e) => e.actor).length, stateChanges.length)}; actor email returned: ${pct(stateChanges.filter((e) => e.actor?.email).length, stateChanges.length)}`);
      log(`    importer history page (25 issues x 50 history): complexity ${complexities.get('teamIssueHistory') ?? 'not reported'}`);
    });
    if (team.private) {
      await attempt('private team members', async () => {
        const members = await pageAll('teamMembers', QUERIES.teamMembers, { id: team.id }, (d) => d.team.members);
        log(`  members: ${members.length} (${members.filter((m) => m.active !== false).length} active); email returned for ${pct(members.filter((m) => m.email).length, members.length)} — these are who would be granted the restricted space`);
      });
    }
  }

  log('');
  log('== People and shared structure (workspace-wide)');
  await attempt('users', async () => {
    const users = await pageAll('users', QUERIES.users, {}, (d) => d.users);
    log(`  users: ${users.length} (${users.filter((u) => u.active).length} active), email returned for ${pct(users.filter((u) => u.email).length, users.length)}`);
  });
  await attempt('projects spanning teams', async () => {
    const projects = await pageAll('projects', QUERIES.projects, {}, (d) => d.projects);
    log(`  projects: ${projects.length}, of which ${projects.filter((p) => p.teams.nodes.length > 1).length} belong to more than one team`);
  });
  await attempt('project milestones', async () => {
    const m = await pageAll('milestones', QUERIES.milestones, {}, (d) => d.projectMilestones);
    log(`  project milestones: ${m.length} (the plan for ticket #1364 expects 182)`);
  });

  log('');
  log('== Not probed by this script (so none of these reads as cleared)');
  log('  issue relations (blocks / related / duplicate) and how many cross teams, attachments, documents: ticket #1365 / #1366 probe them.');
  log('  whether Linear\'s `Duplicate` state really has no category in the StoryOS mirror for the reason above: this only reports Linear\'s side.');
  log('  the cost of a FULL import (this measures one page of each query, not the whole walk), and Linear\'s rate limit under it.');
  log('  whether this key can see every team the import will ask for: only the teams listed above are visible to it.');
  for (const n of notProbed) log(`  could not run: ${n}`);
  return { notProbed };
}

function parseArgs(argv) {
  const args = { teams: [], historySample: DEFAULT_HISTORY_SAMPLE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--teams') args.teams = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--history-sample') args.historySample = Math.max(1, Number(argv[++i]) || DEFAULT_HISTORY_SAMPLE);
    else throw new Error(`unknown argument ${argv[i]} (the API key is never an argument: set LINEAR_API_KEY)`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runProbe({ apiKey: process.env.LINEAR_API_KEY, ...parseArgs(process.argv.slice(2)) });
  } catch (e) {
    const key = process.env.LINEAR_API_KEY;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(key ? msg.split(key).join('[key]') : msg);
    process.exit(1);
  }
}
