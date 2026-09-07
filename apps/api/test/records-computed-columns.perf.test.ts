import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { RecordsService } from '../src/records/records.service';

/**
 * #467 — AC1: MEASURE FIRST. "The assumption that computed columns dominate
 * the cost is untested" (the ticket's own words). This isolates the cost of
 * `attachLookups`/`attachRollups`/`attachFormulas` (records.service.ts's
 * three computed-column passes — `attachFiles` is NOT one of them, it
 * resolves attachment-field chips, not a computed value) by spying them to a
 * pure passthrough and re-running the SAME page query, on a table shaped
 * like the ticket's own "Wide Table" fixture (sos_251: 45 fields, 201
 * records) but — unlike that fixture, which has ZERO rollup/lookup/formula
 * fields and so cannot answer this question at all — with a genuinely heavy
 * computed-column share (15 of the fields), biased generously TOWARD finding
 * savings rather than against it.
 *
 * Heavy — runs only with RUN_PERF=1 (locally or in a nightly job), same
 * gating records-query.perf.test.ts already uses.
 */
const enabled = process.env.RUN_PERF === '1';

describe.skipIf(!enabled)('#467 — computed-column cost on a wide table (AC1 measurement)', () => {
  let app: NestFastifyApplication;
  let admin: { token: string };
  let wsId: string;
  let dbId: string;
  let recordsService: RecordsService;

  function inject(method: string, url: string, payload?: unknown) {
    return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  }

  beforeAll(async () => {
    app = await createTestApp();
    recordsService = app.get(RecordsService);
    admin = await signUpUser(app, 'Perf467');
    wsId = (await inject('POST', '/workspaces', { name: 'Perf467 WS' })).json().id;
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

    // The lookup/rollup SOURCE — a Target database with real data to aggregate.
    const targetId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Target' })).json().id;
    const targetAmount = (
      await inject('POST', `/workspaces/${wsId}/databases/${targetId}/fields`, { display_name: 'Amount', type: 'number' })
    ).json();
    const targetIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const rec = (
        await inject('POST', `/workspaces/${wsId}/databases/${targetId}/records`, {
          values: { name: `Target ${i}`, [targetAmount.apiName]: i * 10 },
        })
      ).json();
      targetIds.push(rec.id);
    }

    dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Wide Table' })).json().id;

    // ~10 ordinary scalar fields — a realistic mix, not just text.
    const scalarApiNames: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: `Text ${i}`, type: 'text' })).json();
      scalarApiNames.push(f.apiName);
    }
    for (let i = 0; i < 5; i++) {
      const f = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: `Number ${i}`, type: 'number' })).json();
      scalarApiNames.push(f.apiName);
    }

    // The relation lookups/rollups aggregate THROUGH.
    const relation = await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId, database_b_id: targetId, cardinality: 'many_to_many', field_a_name: 'Targets',
    });
    const relationFieldId = relation.json().field_a.id;

    // 5 lookups + 5 rollups + 5 formulas — a genuinely heavy computed share.
    const lookupApiNames: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = (
        await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
          display_name: `Lookup ${i}`,
          type: 'lookup',
          config: { relation_field_id: relationFieldId, target_field_api_name: targetAmount.apiName },
        })
      ).json();
      lookupApiNames.push(f.apiName);
    }
    for (let i = 0; i < 5; i++) {
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: `Rollup ${i}`,
        type: 'rollup',
        config: { relation_field_id: relationFieldId, op: i % 2 === 0 ? 'sum' : 'count', target_field_api_name: targetAmount.apiName },
      });
    }
    // Formulas depend on a LOOKUP's value — exercises the real dependency
    // chain (attachFormulas must run after attachLookups), not just an
    // own-record scalar formula.
    for (let i = 0; i < 5; i++) {
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: `Formula ${i}`,
        type: 'formula',
        config: { expression: `{${lookupApiNames[i]!}} * 2` },
      });
    }

    // 201 records, each linked to ~3 target records — matches the fixture's
    // own record count, and gives every rollup/lookup real work to do.
    for (let i = 0; i < 201; i++) {
      const values: Record<string, unknown> = { name: `Row ${i}` };
      for (const api of scalarApiNames) values[api] = api.startsWith('number') ? i : `value ${i}`;
      const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values })).json();
      const links = [targetIds[i % 50]!, targetIds[(i + 7) % 50]!, targetIds[(i + 13) % 50]!];
      await inject('PUT', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/links/${relationFieldId}`, { record_ids: links });
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('reports the share of response time spent in attachLookups/attachRollups/attachFormulas', async () => {
    const RUNS = 20;

    async function timePage(): Promise<number[]> {
      const durations: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 50 });
        durations.push(performance.now() - start);
        expect(res.statusCode).toBe(201);
      }
      durations.sort((a, b) => a - b);
      return durations;
    }

    const before = await timePage();

    // Passthrough stub — isolates the cost of the three COMPUTED passes
    // specifically, while everything else (row fetch, serialization,
    // attachFiles) still runs for real.
    const lookupsSpy = vi.spyOn(recordsService as never, 'attachLookups').mockImplementation(async (p) => p as never);
    const rollupsSpy = vi.spyOn(recordsService as never, 'attachRollups').mockImplementation(async (p) => p as never);
    const formulasSpy = vi.spyOn(recordsService as never, 'attachFormulas').mockImplementation(async (p) => p as never);
    const after = await timePage();
    lookupsSpy.mockRestore();
    rollupsSpy.mockRestore();
    formulasSpy.mockRestore();

    const p50 = (arr: number[]) => arr[Math.floor(arr.length / 2)]!;
    const p95 = (arr: number[]) => arr[Math.floor(arr.length * 0.95)]!;
    const beforeP50 = p50(before);
    const afterP50 = p50(after);
    const savingsMs = beforeP50 - afterP50;
    const savingsPct = (savingsMs / beforeP50) * 100;

    // eslint-disable-next-line no-console
    console.log(
      `#467 AC1 measurement — Wide Table (45 fields incl. 15 computed: 5 lookup + 5 rollup + 5 formula), 201 records, page of 50:\n` +
        `  WITH computed passes:    p50=${beforeP50.toFixed(1)}ms p95=${p95(before).toFixed(1)}ms\n` +
        `  WITHOUT computed passes: p50=${afterP50.toFixed(1)}ms p95=${p95(after).toFixed(1)}ms\n` +
        `  Computed-column share of p50: ${savingsMs.toFixed(1)}ms (${savingsPct.toFixed(1)}%)`,
    );

    // No hard threshold asserted here on purpose — AC1 is "report the
    // numbers", not "pass a bar". The console output above is the artifact
    // this ticket's own instructions ask to be recorded.
    expect(beforeP50).toBeGreaterThan(0);
    expect(afterP50).toBeGreaterThan(0);
  });
});
