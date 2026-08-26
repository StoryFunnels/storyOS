import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFERRED, EXCLUDED, findRule, opKey } from './coverage.js';

/**
 * #397 — the mechanical check that keeps MCP↔API parity from silently reopening.
 *
 * Four capability gaps accumulated without anyone noticing, each found the hard
 * way. An audit alone would have been a snapshot; this makes the exclusion list
 * a REVIEWED ARTEFACT — adding an endpoint without a tool now fails here, and
 * the only way to pass is to write a tool or write down why not.
 *
 * Coverage is DERIVED FROM SOURCE, never from a hand-maintained mapping. A list
 * of "which tool covers which endpoint" would be exactly the thing that drifts,
 * which is the bug this test exists to prevent. `packages/sdk` sets the
 * precedent: it is regenerated from the OpenAPI so it cannot drift. The tool
 * catalog cannot be generated — the descriptions are hand-written prose and that
 * prose is the product — but the coverage CHECK can be mechanical even when the
 * tools are not.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');

function mcpSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return mcpSourceFiles(p);
    return e.isFile() && p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** Every REST route the MCP actually calls, read out of the code. */
function calledEndpoints(): Set<string> {
  const out = new Set<string>();
  for (const file of mcpSourceFiles(join(import.meta.dirname))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/client\.(GET|POST|PATCH|PUT|DELETE)\(\s*'([^']+)'/g)) {
      out.add(opKey(m[1]!, m[2]!));
    }
  }
  return out;
}

function specOperations(): string[] {
  const spec = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (['get', 'post', 'patch', 'put', 'delete'].includes(method.toLowerCase())) {
        ops.push(opKey(method, path));
      }
    }
  }
  return ops.sort();
}

const called = calledEndpoints();
const operations = specOperations();

describe('every API operation is reached, excluded, or deferred (#397)', () => {
  it('leaves NOTHING unclassified — silence is not an outcome', () => {
    const unclassified = operations.filter(
      (op) => !called.has(op) && !findRule(op, EXCLUDED) && !findRule(op, DEFERRED),
    );
    /*
     * The failure message is the point. Someone adding an endpoint should be
     * told exactly what to do, not left to reverse-engineer this file — the
     * CLAUDE.md rule is "a new API capability ships with its MCP tool or an
     * exclusion entry, in the same PR".
     */
    expect(
      unclassified,
      `\n${unclassified.length} API operation(s) have no MCP tool and no entry in coverage.ts:\n` +
        `${unclassified.map((o) => `  ${o}`).join('\n')}\n\n` +
        `Add a tool in tools.ts, or add a rule to EXCLUDED (with a real reason) ` +
        `or DEFERRED (with a ticket) in coverage.ts.\n`,
    ).toEqual([]);
  });

  it('every route the MCP calls actually exists in the spec', () => {
    // Catches the opposite drift: a tool pointing at a route that was renamed
    // or removed. That fails at runtime today, for the user, in production.
    const phantom = [...called].filter((c) => !operations.includes(c));
    expect(phantom, `MCP calls routes that are not in the OpenAPI spec:\n${phantom.join('\n')}`).toEqual([]);
  });

  it('no rule is dead weight', () => {
    // A rule matching nothing is either a typo or a leftover from an endpoint
    // that no longer exists, and it would quietly stop protecting anything.
    const dead = [...EXCLUDED, ...DEFERRED].filter(
      (rule) => !operations.some((op) => findRule(op, [rule])),
    );
    expect(
      dead.map((r) => String(r.match)),
      'These coverage rules match no operation — stale or mistyped.',
    ).toEqual([]);
  });

  it('an exclusion never overlaps something a tool already reaches', () => {
    // If a tool covers it, calling it "deliberately unreachable" is false, and
    // the reason text would mislead the next reader.
    const contradictory = [...called].filter((op) => findRule(op, EXCLUDED));
    expect(
      contradictory,
      'Excluded as unreachable, yet a tool calls it:\n' + contradictory.join('\n'),
    ).toEqual([]);
  });

  it('reports the audit numbers, so the gap is COUNTED and not estimated', () => {
    const covered = operations.filter((op) => called.has(op));
    const excluded = operations.filter((op) => !called.has(op) && findRule(op, EXCLUDED));
    const deferred = operations.filter(
      (op) => !called.has(op) && !findRule(op, EXCLUDED) && findRule(op, DEFERRED),
    );
    // Not an assertion about the ratio — that would fail on every honest PR.
    // It fails only if the three buckets stop summing to the whole, which would
    // mean the classification itself is broken.
    expect(covered.length + excluded.length + deferred.length).toBe(operations.length);
    // eslint-disable-next-line no-console
    console.log(
      `#397 coverage: ${operations.length} operations — ${covered.length} reached by a tool, ` +
        `${excluded.length} excluded by design, ${deferred.length} deferred against a ticket.`,
    );
  });
});
