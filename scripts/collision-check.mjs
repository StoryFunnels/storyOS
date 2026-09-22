#!/usr/bin/env node
/**
 * #747 — the replacement for CLAUDE.md rule 3's hand-maintained list of
 * "hotspot files".
 *
 * That list went stale the way lists do: `field-dialogs.tsx` was decomposed in
 * 2669191 and the rule kept naming it for weeks, while the file that inherited
 * its traffic (`field-dialog-shared.tsx`, 13 commits in 60 days) was never
 * named at all. The rule was written down correctly and protected nothing.
 *
 * So this does not replace the list with a better list, or with a habit. It
 * asks GitHub, on every PR, whether anyone else is already editing the files
 * you are editing.
 *
 * WHY THIS ONE MAY FAIL THE BUILD, WHERE THE CONTRAST ADVISORY MAY NOT (#722):
 * that advisory is report-only because it would go red across ~174 pre-existing
 * sites, and "a check that turns CI red across pre-existing sites gets disabled
 * by the first person it blocks". A collision cannot pre-exist — it only exists
 * between two CURRENTLY-OPEN pull requests, and it disappears when either one
 * lands. There is no backlog for it to go red against, so it can fail closed.
 *
 * FAILING CLOSED IS THE POINT. Every case where it cannot tell — gh missing,
 * unauthenticated, rate-limited, a base it cannot diff, a file list GitHub
 * truncated — exits non-zero and says so. #722's own failure was answering
 * "skipped" and exiting 0 for four days; #745's rule is that unresolvable must
 * never read as "no problem".
 *
 * GITHUB IS THE SOURCE OF TRUTH, NEVER THE TRACKER. storyOS's PR sync stopped
 * at #463 (#666), so tracker PR records are 150+ behind and would confidently
 * match the wrong PR.
 *
 * Lane-agnostic by construction: it compares paths. apps/api binds exactly as
 * apps/web does.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.COLLISION_BASE ?? 'origin/main';
/**
 * The PR being built, so it does not collide with itself.
 *
 * FOUND BY VERA'S ADVERSARIAL PASS, and it was severe: `github.event.pull_request`
 * does not exist on a `merge_group` trigger, so PR_NUMBER arrived EMPTY in the
 * merge queue, SELF became null, the self-exclusion never fired, and the PR was
 * flagged as an undeclared collision WITH ITS OWN FILES. She queued #862 for
 * real and watched it fail. Unconditional — once shipped, nothing would ever
 * have cleared the queue again.
 *
 * Two layers now, because one was what failed:
 *  1. The CI step runs only on `pull_request` (see ci.yml) — by merge-queue time
 *     the warning is too late to serve its purpose anyway, and git already
 *     handles the mechanical conflict.
 *  2. THIS guard, so the script cannot silently self-collide even if a future
 *     trigger change reaches it. A queue ref whose PR number will not parse DIES
 *     rather than proceeding with SELF unknown — the same fail-closed rule the
 *     rest of the file follows, applied to the check's own identity.
 */
const REF = process.env.GITHUB_REF_NAME ?? '';
let SELF = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null;
if (SELF === null && REF.startsWith('gh-readonly-queue/')) {
  const m = REF.match(/\/pr-(\d+)-/);
  if (!m) {
    /* die() is defined below; this branch is re-checked after its definition. */
    SELF = Number.NaN;
  } else {
    SELF = Number(m[1]);
  }
}
/** The PR description, where an intentional overlap is declared. */
const BODY = process.env.PR_BODY ?? '';

function die(why, hint) {
  console.error(`\n  COLLISION CHECK COULD NOT RUN: ${why}`);
  if (hint) console.error(`  ${hint}`);
  console.error('  Treating "cannot tell" as a FAILURE, not as "no collision".\n');
  process.exit(2);
}

function sh(cmd, args) {
  try {
    /* stdio pipe: a tool's own usage dump must not bury our message. A loud
       failure nobody can read is a quiet one. */
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { __error: e?.message ?? String(e) };
  }
}

if (Number.isNaN(SELF)) {
  die('running on a merge-queue ref whose PR number could not be parsed',
      `ref: ${REF} — cannot exclude this PR from its own collision check.`);
}

const diff = sh('git', ['diff', '--name-only', `${BASE}...HEAD`]);
if (typeof diff !== 'string') {
  die(`could not diff against ${BASE}`,
      `Is ${BASE} fetched? CI needs actions/checkout with fetch-depth: 0 — see #847.`);
}
const mine = new Set(diff.split('\n').map((s) => s.trim()).filter(Boolean));

/* This compares COMMITTED state — `origin/main...HEAD`. Running it with work
   still in the working tree would otherwise print "clear" and exit 0, which is
   a silent pass on exactly the state the author cares about. Found by running
   it on its own branch before committing: it said "nothing to compare" and
   passed, which is the failure this whole check exists to prevent, one level
   up. In CI the tree is always clean, so this only bites locally — which is
   where it would have misled someone. */
const dirty = sh('git', ['status', '--porcelain']);
if (typeof dirty !== 'string') die('could not read the working tree state');
const uncommitted = dirty.split('\n').map((s) => s.slice(3).trim()).filter(Boolean);

if (mine.size === 0) {
  if (uncommitted.length > 0) {
    die(`no commits on this branch yet, but ${uncommitted.length} file(s) are uncommitted`,
        'This compares committed state. Commit first, or you are checking nothing.');
  }
  console.log('Collision check: this branch changes no files. Nothing to compare.');
  process.exit(0);
}
if (uncommitted.length > 0) {
  console.error(`  Note: ${uncommitted.length} uncommitted file(s) are NOT part of this check.`);
}

const raw = sh('gh', ['pr', 'list', '--state', 'open', '--limit', '100',
                      '--json', 'number,title,headRefName,files,changedFiles']);
if (typeof raw !== 'string') {
  die('`gh pr list` failed',
      'Not authenticated, offline, or rate-limited. That is NOT the same as "no open PRs".');
}
let prs;
try {
  prs = JSON.parse(raw);
} catch {
  die('`gh` returned unparseable JSON');
}
if (!Array.isArray(prs)) die('`gh` returned an unexpected shape');

/*
 * LAST RESORT, AND THE ONE THAT MAKES THIS CORRECT EVERYWHERE: match the current
 * branch against the open PRs' own head refs.
 *
 * Vera's merge_group finding had a sibling I only saw by running it: locally, on
 * a branch that already has an open PR, nothing identified SELF either — so the
 * check flagged the PR as colliding with its own files. Same defect, different
 * context, and a pre-push hook is exactly where it would have bitten.
 *
 * Deriving identity from the branch removes the dependency on event fields
 * altogether, which was Vera's actual recommendation rather than the narrower
 * fix she offered. It is correct on pull_request, in the queue, locally, and on
 * a push to main — where no open PR has main as its head ref, so SELF stays null
 * and that is the right answer.
 */
if (SELF === null) {
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (typeof branch === 'string') {
    const here = branch.trim();
    const own = prs.find((p) => p.headRefName === here);
    if (own) SELF = own.number;
  }
}

const hits = [];
for (const pr of prs) {
  if (SELF !== null && pr.number === SELF) continue;
  if (!Array.isArray(pr.files)) {
    die(`PR #${pr.number} returned no file list`,
        'GitHub truncates the file list for very large PRs. Cannot compare, so not passing.');
  }
  /* Vera's find: `changedFiles` is the PR's TRUE file count and `gh pr list`
     returns it for free, so a truncated `files` array is detectable with a real
     signal rather than by hoping it comes back a non-array. Confirmed live that
     the two match on an untruncated PR. */
  if (typeof pr.changedFiles === 'number' && pr.changedFiles !== pr.files.length) {
    die(`PR #${pr.number} returned ${pr.files.length} of ${pr.changedFiles} changed files`,
        'GitHub truncated the list, so an overlap could be hiding in the part we cannot see.');
  }
  const shared = pr.files.map((f) => f.path).filter((p) => mine.has(p));
  if (shared.length) hits.push({ pr, shared });
}

if (hits.length === 0) {
  console.log(`Collision check: clear. ${mine.size} file(s) changed, ${prs.length} open PR(s), no overlap.`);
  process.exit(0);
}

/* An overlap is allowed — but declared, in the open, naming the PR. Blocking
   every overlap outright would be routed around within a week; a declaration
   leaves a record that `--no-verify` never does. */
const declared = new Set(
  [...BODY.matchAll(/^\s*Overlaps-With:\s*#(\d+)/gim)].map((m) => Number(m[1])),
);

let undeclared = 0;
console.error('\n  FILES ALSO BEING CHANGED BY AN OPEN PULL REQUEST\n');
for (const { pr, shared } of hits) {
  const ok = declared.has(pr.number);
  if (!ok) undeclared++;
  console.error(`  ${ok ? 'declared ' : 'UNDECLARED'}  #${pr.number}  ${pr.title.slice(0, 58)}`);
  for (const p of shared) console.error(`              ${p}`);
}
if (undeclared === 0) {
  console.error("\n  All overlaps are declared in this PR's description. Passing.\n");
  process.exit(0);
}
console.error(`\n  ${undeclared} undeclared overlap(s).`);
console.error('  Coordinate with the other author, or declare it in the PR description');
console.error('  so the next reader can see it was a choice:\n');
console.error('      Overlaps-With: #NNN — why this is safe\n');
process.exit(1);
