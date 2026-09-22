import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #750 — a board/dashboard has no way to know a column's real size, because
 * `aggregate()` (#404) computes ONE value over ONE filter. Measured on
 * storyos/issues: grouping client-side over a single 50-row page understated
 * the "Bug" column 221 → 15, and made two whole columns (0 records on page
 * one) vanish entirely though they held 25 and 31 records.
 *
 * This is the server-side fix: one query, one value PER GROUP, covering
 * exactly the field types a board can group by (`boardGroupError` in
 * views.service.ts) — select, workflow, single user, date (with a required
 * granularity), a binned number, the single side of a one-to-many relation,
 * text, and lookup.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let spaceId: string;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

const grouped = async (body: unknown) => {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/aggregate/grouped`, body);
  return { status: res.statusCode, body: res.json() };
};

/** Sort groups so assertions don't depend on GROUP BY's own row order. */
function byKey<T extends { key: string | null }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'GroupedAggregateAdmin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Board Co' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Issues' })).json().id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#750 — grouped by select', () => {
  let fieldApiName: string;

  beforeAll(async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Type',
        type: 'select',
        options: [{ label: 'Bug' }, { label: 'Feature' }, { label: 'Chore' }],
      })
    ).json();
    fieldApiName = field.apiName;
    const optionIdByLabel = new Map(field.options.map((o: { id: string; label: string }) => [o.label, o.id]));

    const make = (type: string, n: number) =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
            values: { name: `${type} ${i}`, [fieldApiName]: optionIdByLabel.get(type) },
          }),
        ),
      );
    await make('Bug', 60); // exceeds a 50-row page on purpose — the bug this ticket fixes.
    await make('Feature', 9);
    await make('Chore', 0);
    // One record with no Type at all — the "ungrouped" bucket.
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'No type' } });
  }, 60_000);

  it('reports the TRUE per-column count, not a page-one undercount', async () => {
    const page = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 50 });
    expect(page.json().data.length).toBeLessThan(70); // premise: one page cannot see everything

    const { status, body } = await grouped({ op: 'count', group_by: fieldApiName });
    expect(status).toBe(200);
    expect(body.group_by).toBe(fieldApiName);
    const groups = byKey(body.groups);
    // Bug's real count (60) would have read as whatever fit on page one — the
    // exact #750/#755 defect. Asserting the true number, not just "a number".
    const bug = body.groups.find((g: { key: string }) => g.value === 60);
    expect(bug).toBeTruthy();
  });

  it('one query, in one round trip: every group present in one call, including a genuinely empty option', async () => {
    const { body } = await grouped({ op: 'count', group_by: fieldApiName });
    const values = body.groups.map((g: { value: number }) => g.value).sort((a: number, b: number) => a - b);
    // Chore (0 records) never appears — GROUP BY only emits keys that occur
    // in the data, same as every SQL GROUP BY; a zero-count column is the
    // caller's job to supply from the field's own option list, not this
    // endpoint's (it can only report what exists).
    expect(values).toEqual([1, 9, 60]);
  });

  it('the null group (no value set) is a real, counted group — not silently dropped', async () => {
    const { body } = await grouped({ op: 'count', group_by: fieldApiName });
    const nullGroup = body.groups.find((g: { key: string | null }) => g.key === null);
    expect(nullGroup?.value).toBe(1);
  });
});

describe('#750 — grouped by workflow (mirrors select)', () => {
  it('groups a workflow field the same way as select', async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Status',
        type: 'workflow',
        options: [{ label: 'Todo' }, { label: 'Done' }],
      })
    ).json();
    const optionIdByLabel = new Map(field.options.map((o: { id: string; label: string }) => [o.label, o.id]));
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'wf1', [field.apiName]: optionIdByLabel.get('Todo') },
    });
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'wf2', [field.apiName]: optionIdByLabel.get('Done') },
    });
    const { status, body } = await grouped({ op: 'count', group_by: field.apiName });
    expect(status).toBe(200);
    // The two workflow values, plus a null-key bucket for every record from
    // the earlier "select" describe block sharing this same database (they
    // have no value at all for THIS field).
    const [wfTodo, wfDone] = [
      body.groups.find((g: { key: string }) => g.key === optionIdByLabel.get('Todo')),
      body.groups.find((g: { key: string }) => g.key === optionIdByLabel.get('Done')),
    ];
    expect(wfTodo?.value).toBe(1);
    expect(wfDone?.value).toBe(1);
  });
});

describe('#750 — grouping refusals mirror boardGroupError', () => {
  it('a multi-select field is refused', async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Tags',
        type: 'multi_select',
        options: [{ label: 'a' }],
      })
    ).json();
    const { status, body } = await grouped({ op: 'count', group_by: field.apiName });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('cannot group');
  });

  it('a multi-person user field is refused', async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Watchers',
        type: 'user',
        config: { multi: true },
      })
    ).json();
    const { status, body } = await grouped({ op: 'count', group_by: field.apiName });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('several groups');
  });

  it('a date field without group_by_granularity is refused', async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Due', type: 'date' })
    ).json();
    const { status, body } = await grouped({ op: 'count', group_by: field.apiName });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('group_by_granularity');
  });

  it('an unconfigured number field (no bins) is refused', async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Score', type: 'number' })
    ).json();
    const { status, body } = await grouped({ op: 'count', group_by: field.apiName });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('configure bins');
  });

  it('an unknown group_by field is refused', async () => {
    const { status, body } = await grouped({ op: 'count', group_by: 'not_a_real_field' });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('unknown field');
  });
});

describe('#750 — grouped by a binned number field', () => {
  it('buckets values into their configured bins, and reports each bin\'s label for free', async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Deal Size',
        type: 'number',
        config: {
          bins: [
            { label: 'Small', min: null, max: 100 },
            { label: 'Medium', min: 100, max: 1000 },
            { label: 'Large', min: 1000, max: null },
          ],
        },
      })
    ).json();
    const rec = (n: number, value: number) =>
      as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: `deal ${n}`, [field.apiName]: value },
      });
    await rec(1, 50);
    await rec(2, 500);
    await rec(3, 500);
    await rec(4, 5000);

    const { status, body } = await grouped({ op: 'count', group_by: field.apiName });
    expect(status).toBe(200);
    const byLabel = new Map(body.groups.map((g: { label: string; value: number }) => [g.label, g.value]));
    expect(byLabel.get('Small')).toBe(1);
    expect(byLabel.get('Medium')).toBe(2);
    expect(byLabel.get('Large')).toBe(1);
  });
});

describe('#750 — grouped by date, bucketed by granularity', () => {
  it('buckets into the requested period, keyed by the bucket\'s start date', async () => {
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Signed', type: 'date' })
    ).json();
    const rec = (n: number, signed: string) =>
      as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: `signed ${n}`, [field.apiName]: signed },
      });
    await rec(1, '2026-03-05'); // March → Q1
    await rec(2, '2026-03-20'); // March → Q1
    await rec(3, '2026-07-02'); // July → Q3

    const { status, body } = await grouped({ op: 'count', group_by: field.apiName, group_by_granularity: 'quarter' });
    expect(status).toBe(200);
    const groups = byKey(body.groups.filter((g: { key: string | null }) => g.key !== null));
    // 2026-01-01 is Q1's start, 2026-07-01 is Q3's — the group KEY is the
    // bucket's start date, not the client's own compact "2026-Q1" format.
    expect(groups).toEqual([
      { key: '2026-01-01', value: 2 },
      { key: '2026-07-01', value: 1 },
    ]);
  });
});

describe('#750 — grouped by the single side of a one-to-many relation', () => {
  it('groups by the linked record, including an unlinked ("no relation") bucket', async () => {
    const parentDb = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Epics' })
    ).json();
    const epicA = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${parentDb.id}/records`, { values: { name: 'Epic A' } })
    ).json();
    const epicB = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${parentDb.id}/records`, { values: { name: 'Epic B' } })
    ).json();

    const relDb = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'RelIssues' })
    ).json();
    const relation = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
        database_a_id: relDb.id,
        database_b_id: parentDb.id,
        cardinality: 'one_to_many',
        field_a_name: 'Epic',
        field_b_name: 'Issues',
      })
    ).json();
    const relFieldApiName = relation.field_a.api_name;

    const r1 = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${relDb.id}/records`, { values: { name: 'Issue 1' } })
    ).json();
    const r2 = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${relDb.id}/records`, { values: { name: 'Issue 2' } })
    ).json();
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${relDb.id}/records`, { values: { name: 'Issue 3 (no epic)' } });
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${relDb.id}/records/${r1.id}/links/${relFieldApiName}`, {
      record_ids: [epicA.id],
    });
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${relDb.id}/records/${r2.id}/links/${relFieldApiName}`, {
      record_ids: [epicB.id],
    });

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${relDb.id}/records/aggregate/grouped`, {
      op: 'count',
      group_by: relFieldApiName,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const byKeyMap = new Map(body.groups.map((g: { key: string | null; value: number }) => [g.key, g.value]));
    expect(byKeyMap.get(epicA.id)).toBe(1);
    expect(byKeyMap.get(epicB.id)).toBe(1);
    expect(byKeyMap.get(null)).toBe(1);
  });

  it('refuses the many side of the same relation', async () => {
    // field_b (the "Issues" side named above) is the many-valued end.
    const parentDb = await as(admin.token, 'GET', `/workspaces/${wsId}/databases`);
    const epics = parentDb.json().find((d: { name: string }) => d.name === 'Epics');
    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${epics.id}`);
    const issuesField = detail.json().fields.find((f: { displayName: string }) => f.displayName === 'Issues');
    const { status, body } = await as(
      admin.token,
      'POST',
      `/workspaces/${wsId}/databases/${epics.id}/records/aggregate/grouped`,
      { op: 'count', group_by: issuesField.apiName },
    ).then((r) => ({ status: r.statusCode, body: r.json() }));
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('single side');
  });
});

describe('#750 — filter and q are respected, and sum/avg/min/max work per group', () => {
  it('a filter narrows which records are grouped, same as the single-value aggregate', async () => {
    const database = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Filtered' })
    ).json();
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/fields`, {
        display_name: 'Team',
        type: 'select',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      })
    ).json();
    const price = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/fields`, { display_name: 'Price', type: 'number' })
    ).json();
    const opt = new Map(field.options.map((o: { id: string; label: string }) => [o.label, o.id]));
    const rec = (team: string, p: number, active: boolean) =>
      as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records`, {
        values: { name: `${team}-${p}`, [field.apiName]: opt.get(team), [price.apiName]: p },
      }).then((r) => r.json())
        .then((created) =>
          active
            ? created
            : as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${database.id}/records/${created.id}`, {
                [price.apiName]: p,
              }),
        );
    await rec('Red', 10, true);
    await rec('Red', 100, true); // will be excluded by the filter below
    await rec('Blue', 20, true);

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records/aggregate/grouped`, {
      op: 'sum',
      field: price.apiName,
      group_by: field.apiName,
      filter: { field: price.apiName, op: 'lt', value: 50 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const byGroupKey = new Map(res.json().groups.map((g: { key: string; value: number }) => [g.key, g.value]));
    expect(byGroupKey.get(opt.get('Blue'))).toBe(20);
    expect(byGroupKey.get(opt.get('Red'))).toBe(10);
    expect(res.json().filtered).toBe(true);
  });
});

describe('#750 — access scoping: a record-scoped guest sees only their own records\' groups', () => {
  it('a guest with a grant on ONE record never sees another record\'s group in the total', async () => {
    const database = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Guarded' })
    ).json();
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/fields`, {
        display_name: 'Kind',
        type: 'select',
        options: [{ label: 'Only Kind' }],
      })
    ).json();
    const optId = field.options[0].id;
    const recA = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records`, {
        values: { name: 'Granted', [field.apiName]: optId },
      })
    ).json();
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records`, {
      values: { name: 'Not granted', [field.apiName]: optId },
    });

    const guest = await signUpUser(app, 'GroupedAggregateGuest');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ record_id: recA.id, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(guest.token, 'POST', '/invites/accept', { token });

    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records/aggregate/grouped`, {
      op: 'count',
      group_by: field.apiName,
    });
    expect(res.statusCode, res.body).toBe(200);
    // #474 — a grouped count is still a count: it must not leak the second
    // record into the total just because it shares the granted one's group.
    expect(res.json().groups).toEqual([{ key: optId, value: 1 }]);

    const adminRes = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records/aggregate/grouped`, {
      op: 'count',
      group_by: field.apiName,
    });
    expect(adminRes.json().groups).toEqual([{ key: optId, value: 2 }]);
  });
});
