import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');

/**
 * #542 — the invariant behind PR #859, enforced instead of left as a comment
 * saying "re-check this later" (Otto's ask, after #746/#722 both showed a
 * prose caveat is an artefact that goes stale silently).
 *
 * The property: every MCP tool handler that calls a REST endpoint backed by
 * a `RecordsService` method able to return `PendingApprovalResult` (a
 * workspace-declared action-class gate holding the write instead of
 * performing it — still a 200, not an error) must check the response for
 * `pending_approval`. `delete_record`/`delete_records` had this exact gap
 * until #859: they reported success unconditionally.
 *
 * BOTH ends are derived from source, not hand-typed here — that is the whole
 * point. Today's answer (verified by this test, not asserted by it):
 * `softDelete`/`batchDelete` are the only public RecordsService methods that
 * can return `PendingApprovalResult` (`records.service.ts` is the only
 * caller of `ActionGatesService.check`, and `delete_records` is the only
 * declared action class so far — see #542's PR #801/#859 comments), mapping
 * to `DELETE .../records/{rec}` and `POST .../records/batch-delete`. When
 * Phase 3 adds a new gated action class and some OTHER RecordsService method
 * starts returning `PendingApprovalResult`, this test starts scanning that
 * method's route too — and goes red if the handler that calls it doesn't
 * check for the flag, without anyone needing to remember this comment.
 *
 * Deliberately narrow to RecordsService/records.controller.ts, matching
 * where `PendingApprovalResult` actually lives today. If a later ticket adds
 * the type to another service, this test's `gatedServiceMethods`/
 * `gatedRoutes` pair is the template to extend, not a reason to add a
 * second, independent check.
 */

/** Public (non-private) RecordsService methods whose declared return type includes PendingApprovalResult. */
function gatedServiceMethods(): Set<string> {
  const lines = readFileSync(join(REPO, 'apps/api/src/records/records.service.ts'), 'utf8').split('\n');
  let current: string | null = null;
  let currentIsPrivate = false;
  const hits = new Set<string>();
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)![1]!.length;
    // Class-member declarations in this file sit at 2-space indent — this
    // intentionally does NOT try to parse TypeScript in general, only to
    // track "which method are we inside" well enough for the check below.
    const decl = line.match(/^\s*(?:(private|public|protected)\s+)?(?:async\s+)?(\w+)\s*\(/);
    if (decl && indent === 2) {
      current = decl[2]!;
      currentIsPrivate = decl[1] === 'private';
    }
    if (/\):\s*Promise<[^>]*PendingApprovalResult/.test(line) && current && !currentIsPrivate) {
      hits.add(current);
    }
  }
  return hits;
}

interface Route {
  verb: string;
  path: string;
  via: string;
}

/** REST routes in records.controller.ts whose handler calls one of `methods` on `this.recordsService`. */
function gatedRoutes(methods: Set<string>): Route[] {
  const lines = readFileSync(join(REPO, 'apps/api/src/records/records.controller.ts'), 'utf8').split('\n');
  const base = 'workspaces/:ws/databases/:db/records';
  let currentRoute: { verb: string; path: string } | null = null;
  const routes: Route[] = [];
  for (const line of lines) {
    const dec = line.match(/^\s*@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/);
    if (dec) {
      currentRoute = { verb: dec[1]!.toUpperCase(), path: dec[2] ?? '' };
      continue;
    }
    if (!currentRoute) continue;
    const call = line.match(/this\.recordsService\.(\w+)\(/);
    if (call && methods.has(call[1]!)) {
      const full = currentRoute.path ? `${base}/${currentRoute.path}` : base;
      const openapiPath = `/api/v1/${full}`.replace(/:(\w+)/g, '{$1}');
      routes.push({ verb: currentRoute.verb, path: openapiPath, via: call[1]! });
    }
  }
  return routes;
}

/** Every `client.<VERB>('<path>' ...)` call site in tools.ts, with the source window up to that reg()'s end. */
function mcpCallSites(verb: string, path: string): string[] {
  const src = readFileSync(join(REPO, 'packages/mcp/src/tools.ts'), 'utf8');
  const needle = `client.${verb}('${path}'`;
  const windows: string[] = [];
  let from = 0;
  for (;;) {
    const idx = src.indexOf(needle, from);
    if (idx === -1) break;
    const nextReg = src.indexOf('\n  reg(', idx + needle.length);
    windows.push(src.slice(idx, nextReg === -1 ? src.length : nextReg));
    from = idx + needle.length;
  }
  return windows;
}

const methods = gatedServiceMethods();
const routes = gatedRoutes(methods);

describe('#542 — every MCP handler reaching a gate-able write checks for pending_approval', () => {
  it('found the routes this test is supposed to be checking (a red herring if this list ever goes empty)', () => {
    // If RecordsService stops returning PendingApprovalResult from anywhere,
    // or the controller stops calling it, this test would otherwise pass by
    // having nothing to check — which is indistinguishable from "the
    // invariant holds" unless something here says so explicitly.
    expect(routes.length).toBeGreaterThan(0);
  });

  for (const route of routes) {
    it(`${route.verb} ${route.path} (via RecordsService.${route.via}) is reported honestly by its MCP handler(s)`, () => {
      const windows = mcpCallSites(route.verb, route.path);
      expect(windows.length, `No MCP handler calls ${route.verb} ${route.path} at all — see coverage.test.ts (#397).`).toBeGreaterThan(0);
      for (const [i, w] of windows.entries()) {
        expect(
          w.includes('pending_approval'),
          `MCP call site #${i} for ${route.verb} ${route.path} doesn't check the response for ` +
            `'pending_approval' — RecordsService.${route.via} can return PendingApprovalResult, so this ` +
            `handler can report a held write as a completed one (#542, the bug fixed in PR #859).`,
        ).toBe(true);
      }
    });
  }
});

/**
 * #1104 — the same invariant for the per-agent write gate, which HOLDS a record create/update and answers 202
 * `{ pending_approval: true, approval_id }` (a thrown WriteHeldForApprovalException, not a PendingApprovalResult return,
 * so the scan above cannot see it). Derived from the code like the block above, not hand-typed: the RecordsService methods
 * whose body calls `holdIfAgentGated`, plus every method that calls one of them (upsert -> create/update, batchUpdate ->
 * update), then the controller routes reaching those, then the MCP handlers calling those routes.
 *
 * A handler that reads the written record back (`id` of the response) would crash or lie on the held body, so it must go
 * through `heldWrite(`; a handler that returns the REST body verbatim (`return text(res)`) already tells the truth.
 */
function holdingMethods(): Set<string> {
  const lines = readFileSync(join(REPO, 'apps/api/src/records/records.service.ts'), 'utf8').split('\n');
  const bodies = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines) {
    const decl = line.match(/^ {2}(?:(?:private|public|protected)\s+)?(?:async\s+)?(\w+)\s*\(/);
    if (decl) {
      current = decl[1]!;
      bodies.set(current, '');
    }
    if (current) bodies.set(current, bodies.get(current)! + line + '\n');
  }
  const holding = new Set<string>(['createBatch', 'update']);
  // The two direct holders are confirmed here, so a rename of the helper (or dropping the call) goes red.
  for (const m of holding) {
    if (!bodies.get(m)?.includes('holdIfAgentGated(')) throw new Error(`RecordsService.${m} no longer calls holdIfAgentGated`);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      // A method that REFUSES a gated agent (duplicate, restoreVersion) answers an error, not a 202: nothing to misreport.
      if (holding.has(name) || name === 'holdIfAgentGated' || body.includes('refuseIfAgentGated(')) continue;
      for (const h of [...holding]) {
        if (body.includes(`this.${h}(`)) {
          holding.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return holding;
}

const holdRoutes = gatedRoutes(holdingMethods());

describe('#1104 — every MCP handler reaching a per-agent-gated write reports a held write honestly', () => {
  it('found the routes this test is supposed to be checking', () => {
    expect(holdRoutes.length).toBeGreaterThan(3);
  });

  for (const route of holdRoutes) {
    it(`${route.verb} ${route.path} (via RecordsService.${route.via}) handles a 202 pending_approval body`, () => {
      const windows = mcpCallSites(route.verb, route.path);
      // Not every route has a tool (see coverage.test.ts); a route with none has nothing to misreport.
      for (const [i, w] of windows.entries()) {
        const verbatim = w.includes('return text(res)');
        expect(
          verbatim || w.includes('heldWrite('),
          `MCP call site #${i} for ${route.verb} ${route.path} neither returns the REST body verbatim nor checks heldWrite(): ` +
            `a gated agent's write answers 202 { pending_approval }, so this handler would read back a record that was never written (#1104).`,
        ).toBe(true);
      }
    });
  }
});

/**
 * #1178 — the same invariant for the agent's own `delete` approval_policy, which HOLDS a run credential's direct delete and answers
 * 202 `{ pending_approval: true, approval_id }` from every route marked `@HoldsAgentDeletes` in the API. Derived from the controllers'
 * source, not hand-typed: a delete route added tomorrow with the marker is scanned without anyone editing this file. A tool that
 * reported `{ deleted: ... }` for it would tell an agent the data is gone when it is waiting for a person.
 */
function heldDeleteRoutes(): Route[] {
  const srcDir = join(REPO, 'apps/api/src');
  const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.controller.ts'));
  const found: Route[] = [];
  for (const f of files) {
    const lines = readFileSync(join(srcDir, f), 'utf8').split('\n');
    let base = '';
    let marked: string | null = null;
    for (const line of lines) {
      const ctl = line.match(/^@Controller\(\s*'([^']*)'\s*\)/);
      if (ctl) base = ctl[1]!;
      const mark = line.match(/^\s*@HoldsAgentDeletes\(\s*'(\w+)'\s*\)/);
      if (mark) marked = mark[1]!;
      const dec = line.match(/^\s*@(Delete|Post)\(\s*(?:'([^']*)')?\s*\)/);
      if (dec && marked) {
        const full = dec[2] ? `${base}/${dec[2]}` : base;
        found.push({ verb: dec[1]!.toUpperCase(), path: `/api/v1/${full}`.replace(/:(\w+)/g, '{$1}'), via: marked });
        marked = null;
      }
    }
  }
  return found;
}

describe('#1178 — every MCP handler reaching an agent-policy-held delete reports a held delete honestly', () => {
  const held = heldDeleteRoutes();
  it('found the routes this test is supposed to be checking (all ten at the time of writing)', () => {
    expect(held.length).toBeGreaterThanOrEqual(10);
  });
  for (const route of held) {
    it(`${route.verb} ${route.path} (${route.via}) handles a 202 pending_approval body`, () => {
      const windows = mcpCallSites(route.verb, route.path);
      // Not every route has a tool (coverage.test.ts decides that); a route with none has nothing to misreport.
      for (const [i, w] of windows.entries()) {
        expect(
          w.includes('heldDelete(') || w.includes('pending_approval'),
          `MCP call site #${i} for ${route.verb} ${route.path} does not check for a held delete: an agent whose approval_policy lists ` +
            `"delete" gets 202 { pending_approval }, so this handler would report { deleted } for data that is still there (#1178).`,
        ).toBe(true);
      }
    });
  }
});
