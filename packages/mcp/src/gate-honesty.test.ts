import { readFileSync } from 'node:fs';
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
