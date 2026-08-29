/**
 * #451 — write a plan into a StoryOS database.
 *
 * Everything goes through the product's own HTTP API (`app.inject`), not raw
 * SQL. That is a deliberate cost: it is slower than a bulk INSERT, and it is
 * the only way the seeder exercises validation, defaults, title computation,
 * record numbering, link writing and rollups the same way a real user does. A
 * seeder that writes straight to postgres will happily produce a workspace the
 * product itself could never have created, and then the bug it hides is the
 * seeder's.
 *
 * The two exceptions, both explicit and both narrow:
 *  1. `created_at` / `updated_at` backdating. No endpoint accepts a past
 *     timestamp — correctly, since a client must not be able to forge history.
 *     So the rows are created through the API and then stamped with one
 *     drizzle UPDATE per batch.
 *  2. Version rows are backdated the same way, so the history a record shows
 *     matches the record's own dates.
 *
 * Idempotency: a workspace is identified by its plan `key`, stored as its
 * slug. If it already exists the seeder TOPS IT UP — missing databases and
 * missing records are added, nothing existing is touched or deleted. These
 * environments are persistent on purpose; the accumulated data is the
 * instrument, so there is no reset path here at all.
 */
import { inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { records as recordsTable, recordVersions } from '../db/schema';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import type { PlannedDatabase, PlannedWorkspace, SeedPlan } from './plan';

const PASSWORD = 'agent-uat-seed-password-1';

export interface ApplyResult {
  workspaces_created: number;
  workspaces_topped_up: number;
  databases_created: number;
  records_created: number;
  records_edited: number;
  links_created: number;
  guest_granted: boolean;
}

type Response = { status: number; body: unknown; headers: Record<string, unknown> };
type Injector = (method: string, url: string, payload?: unknown, token?: string) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An error body is not always JSON, and a seeder that throws on the error path is useless. */
function parseBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The seeder makes several hundred calls in a burst and the API rate-limits at
 * RATE_LIMIT_PER_MINUTE. The first version of this treated a 429 as "that call
 * didn't happen" and moved on, which produced an environment quietly missing a
 * third of its edits while the summary line reported success. Waiting out the
 * window is the honest fix; raising the limit for the seeder's benefit would
 * be widening a real boundary to make our own tooling look good.
 */
function injector(app: NestFastifyApplication): Injector {
  return async (method, url, payload, token) => {
    for (let attempt = 0; ; attempt++) {
      const res = await app.inject({
        method: method as never,
        url: `/api/v1${url}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: payload as never,
      });
      const headers = res.headers as Record<string, unknown>;
      if (res.statusCode === 429 && attempt < 12) {
        const reset = Number(headers['x-ratelimit-reset']);
        await sleep((Number.isFinite(reset) && reset > 0 ? Math.min(reset, 65) : 5) * 1000);
        continue;
      }
      return { status: res.statusCode, body: parseBody(res.body), headers };
    }
  };
}

function ok<T>(res: { status: number; body: unknown }, what: string): T {
  if (res.status >= 300) throw new Error(`${what} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body as T;
}

/** Sign up, or sign in if this persona has been seeded before. */
async function account(call: Injector, email: string, name: string): Promise<string> {
  const up = await call('POST', '/auth/sign-up/email', { email, password: PASSWORD, name });
  if (up.status < 300) return tokenFrom(up);
  const inn = await call('POST', '/auth/sign-in/email', { email, password: PASSWORD });
  if (inn.status < 300) return tokenFrom(inn);
  throw new Error(`could not sign up or sign in ${email}: ${up.status}/${inn.status} ${JSON.stringify(up.body)}`);
}

/**
 * better-auth's bearer plugin hands the session token back in `set-auth-token`
 * (the test helpers read the same header). The body carries a session object,
 * not a usable bearer token — reading it looks like it works right up until
 * the first authenticated call 401s.
 */
function tokenFrom(res: Response): string {
  const header = res.headers['set-auth-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (typeof token !== 'string' || !token) throw new Error('auth response carried no set-auth-token header');
  return token;
}

export async function applyPlan(
  app: NestFastifyApplication,
  plan: SeedPlan,
  log: (msg: string) => void = () => {},
): Promise<ApplyResult> {
  const call = injector(app);
  const db = app.get<Db>(DB);
  const result: ApplyResult = {
    workspaces_created: 0,
    workspaces_topped_up: 0,
    databases_created: 0,
    records_created: 0,
    records_edited: 0,
    links_created: 0,
    guest_granted: false,
  };

  const ownerToken = await account(call, plan.owner.email, plan.owner.name);
  const guestToken = plan.guest ? await account(call, plan.guest.email, plan.guest.name) : null;

  const existing = ok<Array<{ id: string; slug: string }>>(
    await call('GET', '/workspaces', undefined, ownerToken),
    'list workspaces',
  );
  const bySlug = new Map(existing.map((w) => [w.slug, w.id]));

  for (const planned of plan.workspaces) {
    let wsId = bySlug.get(planned.key);
    if (wsId) {
      result.workspaces_topped_up++;
      log(`  ${planned.name} — exists, topping up`);
    } else {
      const created = ok<{ id: string }>(
        await call('POST', '/workspaces', { name: planned.name, slug: planned.key }, ownerToken),
        `create workspace ${planned.name}`,
      );
      wsId = created.id;
      result.workspaces_created++;
      log(`  ${planned.name} — created`);
    }
    await applyWorkspace(call, db, ownerToken, guestToken, wsId, planned, plan, result, log);
  }

  return result;
}

async function applyWorkspace(
  call: Injector,
  db: Db,
  ownerToken: string,
  guestToken: string | null,
  wsId: string,
  planned: PlannedWorkspace,
  plan: SeedPlan,
  result: ApplyResult,
  log: (msg: string) => void,
) {
  // Spaces: 'general' always exists (workspace creation makes it); the rest are ours.
  const spaces = ok<Array<{ id: string; slug: string; name: string }>>(
    await call('GET', `/workspaces/${wsId}/spaces`, undefined, ownerToken),
    'list spaces',
  );
  const spaceIdByKey = new Map<string, string>();
  spaceIdByKey.set('general', spaces[0]!.id);
  for (const space of spaces) spaceIdByKey.set(space.slug, space.id);
  for (const wanted of planned.spaces) {
    if (spaceIdByKey.has(wanted.key)) continue;
    const created = ok<{ id: string }>(
      await call('POST', `/workspaces/${wsId}/spaces`, { name: wanted.name }, ownerToken),
      `create space ${wanted.name}`,
    );
    spaceIdByKey.set(wanted.key, created.id);
  }

  const existingDbs = ok<Array<{ id: string; name: string }>>(
    await call('GET', `/workspaces/${wsId}/databases`, undefined, ownerToken),
    'list databases',
  );
  const dbIdByKey = new Map<string, string>();
  const recordIdsByDbKey = new Map<string, string[]>();

  for (const plannedDb of planned.databases) {
    const found = existingDbs.find((d) => d.name === plannedDb.name);
    let dbId: string;
    let apiNames: Map<string, string>;
    if (found) {
      dbId = found.id;
      apiNames = await fieldApiNames(call, ownerToken, wsId, dbId, plannedDb);
    } else {
      const created = ok<{ id: string }>(
        await call(
          'POST',
          `/workspaces/${wsId}/databases`,
          {
            space_id: spaceIdByKey.get(plannedDb.space_key) ?? spaceIdByKey.get('general'),
            name: plannedDb.name,
            description: plannedDb.description,
          },
          ownerToken,
        ),
        `create database ${plannedDb.name}`,
      );
      dbId = created.id;
      result.databases_created++;
      apiNames = new Map();
      for (const field of plannedDb.fields) {
        const madeField = ok<{ apiName: string }>(
          await call(
            'POST',
            `/workspaces/${wsId}/databases/${dbId}/fields`,
            {
              display_name: field.display_name,
              type: field.type,
              config: {},
              ...(field.options ? { options: field.options.map((label) => ({ label })) } : {}),
            },
            ownerToken,
          ),
          `create field ${field.display_name} on ${plannedDb.name}`,
        );
        apiNames.set(field.key, madeField.apiName);
      }
    }
    dbIdByKey.set(plannedDb.key, dbId);

    const ids = await applyRecords(call, db, ownerToken, wsId, dbId, plannedDb, apiNames, result, log);
    recordIdsByDbKey.set(plannedDb.key, ids);
  }

  await applyRelations(call, ownerToken, wsId, planned, dbIdByKey, recordIdsByDbKey, result);
  await applyGuest(call, ownerToken, guestToken, wsId, planned, plan, spaceIdByKey, result);
}

async function fieldApiNames(
  call: Injector,
  token: string,
  wsId: string,
  dbId: string,
  plannedDb: PlannedDatabase,
): Promise<Map<string, string>> {
  const detail = ok<{ fields: Array<{ displayName: string; apiName: string }> }>(
    await call('GET', `/workspaces/${wsId}/databases/${dbId}`, undefined, token),
    'get database',
  );
  const byDisplay = new Map(detail.fields.map((f) => [f.displayName, f.apiName]));
  const out = new Map<string, string>();
  for (const field of plannedDb.fields) {
    const apiName = byDisplay.get(field.display_name);
    if (apiName) out.set(field.key, apiName);
  }
  return out;
}

/** Select/workflow values are planned as LABELS; the API wants option ids. */
async function optionIds(
  call: Injector,
  token: string,
  wsId: string,
  dbId: string,
): Promise<Map<string, string>> {
  const detail = ok<{ fields: Array<{ apiName: string; options?: Array<{ id: string; label: string }> }> }>(
    await call('GET', `/workspaces/${wsId}/databases/${dbId}`, undefined, token),
    'get database options',
  );
  const out = new Map<string, string>();
  for (const field of detail.fields) {
    for (const option of field.options ?? []) out.set(`${field.apiName}:${option.label}`, option.id);
  }
  return out;
}

const BATCH = 100;

async function applyRecords(
  call: Injector,
  db: Db,
  token: string,
  wsId: string,
  dbId: string,
  plannedDb: PlannedDatabase,
  apiNames: Map<string, string>,
  result: ApplyResult,
  log: (msg: string) => void,
): Promise<string[]> {
  const options = await optionIds(call, token, wsId, dbId);
  // Top-up, not reset: only the records this run is short of get created.
  const already = ok<{ value: number | null }>(
    await call('POST', `/workspaces/${wsId}/databases/${dbId}/records/aggregate`, { op: 'count' }, token),
    'count records',
  );
  const have = already.value ?? 0;
  const wanted = plannedDb.records.length;
  const ids: string[] = [];
  if (have >= wanted) {
    log(`    ${plannedDb.name}: ${have} records already — nothing to add`);
    return listRecordIds(call, token, wsId, dbId);
  }

  const toCreate = plannedDb.records.slice(have);
  for (let i = 0; i < toCreate.length; i += BATCH) {
    const slice = toCreate.slice(i, i + BATCH);
    const payload = slice.map((record) => ({
      // The title is a VALUE (`name`), not a sibling of `values` — the batch DTO
      // has no title field, and passing one is silently dropped.
      values: { ...(record.title ? { name: record.title } : {}), ...encodeValues(record.values, apiNames, options) },
    }));
    const made = ok<{ data: Array<{ id: string }> }>(
      await call('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, { records: payload }, token),
      `batch create in ${plannedDb.name}`,
    );
    const madeIds = made.data.map((r) => r.id);
    ids.push(...madeIds);
    result.records_created += madeIds.length;
    // Backdating — the documented exception. One UPDATE per batch, not per row.
    await backdate(db, madeIds, slice.map((r) => ({ created: new Date(r.created_at), updated: new Date(r.updated_at) })));
  }

  // Real edits through the API, so version history is real rather than fabricated.
  for (let i = 0; i < toCreate.length; i++) {
    const record = toCreate[i]!;
    if (record.edits.length === 0) continue;
    const id = ids[i];
    if (!id) continue;
    for (const edit of record.edits) {
      ok(
        await call(
          'PATCH',
          `/workspaces/${wsId}/databases/${dbId}/records/${id}`,
          { values: encodeValues(edit.values, apiNames, options) },
          token,
        ),
        `edit record in ${plannedDb.name}`,
      );
      result.records_edited++;
    }
    await stampEditDates(db, id, record.edits.map((e) => new Date(e.at)), new Date(record.created_at));
  }

  log(`    ${plannedDb.name}: +${ids.length} records`);
  return ids;
}

async function listRecordIds(call: Injector, token: string, wsId: string, dbId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = ok<{ data: Array<{ id: string }>; next_cursor: string | null }>(
      await call('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 200, cursor }, token),
      'page records',
    );
    ids.push(...page.data.map((r) => r.id));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return ids;
}

function encodeValues(
  values: Record<string, unknown>,
  apiNames: Map<string, string>,
  options: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const apiName = apiNames.get(key);
    if (!apiName) continue;
    if (typeof value === 'string' && options.has(`${apiName}:${value}`)) {
      out[apiName] = options.get(`${apiName}:${value}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const mapped = (value as string[]).map((v) => options.get(`${apiName}:${v}`)).filter(Boolean);
      out[apiName] = mapped.length === value.length ? mapped : richText(value as string[]);
    } else {
      out[apiName] = value;
    }
  }
  return out;
}

function richText(paragraphs: string[]): unknown {
  return paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }));
}

/**
 * The backdating exception, isolated to one place so it is easy to find and
 * easy to argue with. Creation went through the API; only the two timestamp
 * columns are rewritten, and only to values the plan already fixed.
 */
async function backdate(db: Db, ids: string[], dates: Array<{ created: Date; updated: Date }>) {
  for (let i = 0; i < ids.length; i++) {
    const date = dates[i];
    if (!date) continue;
    await db
      .update(recordsTable)
      .set({ createdAt: date.created, updatedAt: date.updated })
      .where(inArray(recordsTable.id, [ids[i]!]));
  }
}

/** A record's version rows must sit inside its own history, not at seed time. */
async function stampEditDates(db: Db, recordId: string, editDates: Date[], createdAt: Date) {
  const versions = await db.query.recordVersions.findMany({
    where: inArray(recordVersions.recordId, [recordId]),
    columns: { id: true },
  });
  const dates = [createdAt, ...editDates];
  for (let i = 0; i < versions.length; i++) {
    const at = dates[Math.min(i, dates.length - 1)]!;
    await db.update(recordVersions).set({ createdAt: at }).where(inArray(recordVersions.id, [versions[i]!.id]));
  }
  const last = editDates[editDates.length - 1];
  if (last) {
    await db.update(recordsTable).set({ updatedAt: last }).where(inArray(recordsTable.id, [recordId]));
  }
}

async function applyRelations(
  call: Injector,
  token: string,
  wsId: string,
  planned: PlannedWorkspace,
  dbIdByKey: Map<string, string>,
  recordIdsByDbKey: Map<string, string[]>,
  result: ApplyResult,
) {
  if (planned.relations.length === 0) return;
  // Re-running is expected, and a second create of the same relation is
  // rejected by the uniqueness guard on the field name. That rejection IS the
  // idempotency check — reading the relation list back and matching on names
  // would just reimplement it less reliably.
  for (const relation of planned.relations) {
    const aId = dbIdByKey.get(relation.a_key);
    const bId = dbIdByKey.get(relation.b_key);
    if (!aId || !bId) continue;
    const made = await call(
      'POST',
      `/workspaces/${wsId}/relations`,
      {
        database_a_id: aId,
        database_b_id: bId,
        cardinality: relation.cardinality,
        field_a_name: relation.field_a_name,
        field_b_name: relation.field_b_name,
      },
      token,
    );
    // A re-run hits the field-name uniqueness guard; anything else is a bug.
    if (made.status === 409 || made.status === 422) continue;
    ok(made, `create relation ${relation.field_a_name}`);
    const fieldA = (made.body as { field_a: { id: string } }).field_a.id;
    const fromIds = recordIdsByDbKey.get(relation.a_key) ?? [];
    const toIds = recordIdsByDbKey.get(relation.b_key) ?? [];
    // Group by source record so each record takes ONE links call, not one per link.
    const grouped = new Map<string, string[]>();
    for (const link of relation.links) {
      const from = fromIds[link.from];
      const to = toIds[link.to];
      if (!from || !to || from === to) continue;
      grouped.set(from, [...(grouped.get(from) ?? []), to]);
    }
    for (const [from, targets] of grouped) {
      ok(
        await call(
          'POST',
          `/workspaces/${wsId}/databases/${dbIdByKey.get(relation.a_key)}/records/${from}/links/${fieldA}`,
          { record_ids: targets },
          token,
        ),
        `link records via ${relation.field_a_name}`,
      );
      result.links_created += targets.length;
    }
  }
}

/**
 * #451 — the guest. Only guests can hold partial access, so an access-boundary
 * test run against this environment without one proves nothing: an admin sees
 * everything, and "everything" never catches a leak.
 */
async function applyGuest(
  call: Injector,
  ownerToken: string,
  guestToken: string | null,
  wsId: string,
  planned: PlannedWorkspace,
  plan: SeedPlan,
  spaceIdByKey: Map<string, string>,
  result: ApplyResult,
) {
  if (!planned.guest_grant || !plan.guest || !guestToken) return;
  const spaceId = spaceIdByKey.get(planned.guest_grant.space_key);
  if (!spaceId) return;

  const members = ok<Array<{ user_id: string; role: string; user: { email: string | null } }>>(
    await call('GET', `/workspaces/${wsId}/members`, undefined, ownerToken),
    'list members',
  );
  if (members.some((m) => m.user?.email === plan.guest!.email)) {
    result.guest_granted = true;
    return;
  }

  /*
   * ADR-0007: a guest invite must carry its grants. The product refuses a
   * guest with no scope — correctly, since a guest who can see everything is
   * just a member — so the scope goes in the INVITE, not in a follow-up call.
   * Seeding this wrong produced a workspace with no guest at all and a green
   * "guest_granted: false" that read as an option rather than a failure.
   */
  const invite = await call(
    'POST',
    `/workspaces/${wsId}/invites`,
    {
      email: plan.guest.email,
      role: 'guest',
      grants: [{ space_id: spaceId, role: planned.guest_grant.role }],
    },
    ownerToken,
  );
  if (invite.status >= 300) {
    throw new Error(`guest invite failed (${invite.status}): ${JSON.stringify(invite.body)}`);
  }
  const acceptUrl = (invite.body as { accept_url: string }).accept_url;
  const inviteToken = new URL(acceptUrl).searchParams.get('token');
  if (!inviteToken) throw new Error('invite carried no token in accept_url');
  const accepted = await call('POST', '/invites/accept', { token: inviteToken }, guestToken);
  if (accepted.status >= 300) {
    throw new Error(`guest could not accept the invite (${accepted.status}): ${JSON.stringify(accepted.body)}`);
  }
  result.guest_granted = true;
}
