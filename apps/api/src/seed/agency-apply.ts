/**
 * #1297 — write Pinewood Studio into a database, through the product's own HTTP API.
 *
 * Same discipline as seed/apply.ts (and it reuses its injector, `ok` and `backdate`): every row is
 * made by the endpoint a person or an agent would use, so validation, record numbers, titles, links,
 * member projection (ADR-0017: the people in Members come from memberships, never written by hand),
 * agent attribution and the approval gate all behave as in production. The only direct writes are
 * the two apply.ts already documents (backdating `created_at`/`updated_at`) plus the plan's seat
 * allowance, which goes through EntitlementsService.setOverride, the seam the admin panel uses.
 *
 * Idempotent by identity, not by count: a record is "there" when a record with that title is in that
 * database. A re-run creates what is missing and touches NOTHING else, so a person's own edits and
 * records in the workspace survive. There is no reset path, on purpose; dropping the database is a
 * decision, not a flag.
 *
 * This function does not check which database it is pointed at. The command (agency.ts) does that
 * before the app boots; keeping the check out of here lets the tests run it against their own database.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { EntitlementsService } from '../billing/entitlements.service';
import { backdate, injector, ok, tokenFrom, type Injector } from './apply';
import {
  AGENCY_WORKSPACE,
  AGENT_LOGINS,
  EXTRA_DATABASES,
  PACKS,
  STUDIO_CAST,
  buildAgencyData,
  type AgencyData,
  type CastMember,
  type PlannedRecord,
} from './agency-data';

export interface AgencyResult {
  workspace_id: string;
  workspace_created: boolean;
  packs_installed: number;
  databases_created: number;
  people_created: number;
  members_invited: number;
  records_created: number;
  links_created: number;
  agent_comments_created: number;
  approval_pending: boolean;
  /** key -> number of records now in that database, whoever made them. */
  counts: Record<string, number>;
}

export interface AgencyOptions {
  password: string;
  /** Pin "today" (tests). Defaults to now. */
  today?: Date;
  log?: (msg: string) => void;
  /** How long to wait for the approval-gated rule to raise its approval. */
  approvalWaitMs?: number;
}

interface DbRef {
  id: string;
  fields: Map<string, { id: string; apiName: string; type: string }>;
  options: Map<string, string>;
}

async function signUpOrIn(call: Injector, person: CastMember, password: string): Promise<{ token: string; created: boolean }> {
  const up = await call('POST', '/auth/sign-up/email', { email: person.email, password, name: person.name });
  if (up.status < 300) return { token: tokenFrom(up), created: true };
  const inn = await call('POST', '/auth/sign-in/email', { email: person.email, password });
  if (inn.status < 300) return { token: tokenFrom(inn), created: false };
  throw new Error(
    `could not sign up or sign in ${person.email} (${up.status}/${inn.status}). If this person exists with a different password, ` +
      `set PINEWOOD_SEED_PASSWORD to the one they were created with: ${JSON.stringify(up.body)}`,
  );
}

function plain(blocks: unknown): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      if (typeof n !== 'object' || n === null) continue;
      const b = n as { text?: unknown; content?: unknown; children?: unknown };
      if (typeof b.text === 'string') out.push(b.text);
      if (Array.isArray(b.content)) walk(b.content);
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  if (Array.isArray(blocks)) walk(blocks);
  return out.join(' ');
}

export async function applyAgency(app: NestFastifyApplication, opts: AgencyOptions): Promise<AgencyResult> {
  const call = injector(app);
  const db = app.get<Db>(DB);
  const log = opts.log ?? (() => {});
  const today = opts.today ?? new Date();
  const data = buildAgencyData(today);
  const result: AgencyResult = {
    workspace_id: '',
    workspace_created: false,
    packs_installed: 0,
    databases_created: 0,
    people_created: 0,
    members_invited: 0,
    records_created: 0,
    links_created: 0,
    agent_comments_created: 0,
    approval_pending: false,
    counts: {},
  };

  // 1. The owner, then the workspace.
  const maya = STUDIO_CAST.find((p) => p.key === 'maya')!;
  const owner = await signUpOrIn(call, maya, opts.password);
  if (owner.created) result.people_created++;
  const token = owner.token;
  const mine = ok<Array<{ id: string; slug: string }>>(await call('GET', '/workspaces', undefined, token), 'list workspaces');
  let wsId = mine.find((w) => w.slug === AGENCY_WORKSPACE.slug)?.id;
  if (!wsId) {
    wsId = ok<{ id: string }>(
      await call('POST', '/workspaces', { name: AGENCY_WORKSPACE.name, slug: AGENCY_WORKSPACE.slug }, token),
      'create workspace',
    ).id;
    result.workspace_created = true;
    log(`  ${AGENCY_WORKSPACE.name}: created`);
  } else {
    log(`  ${AGENCY_WORKSPACE.name}: exists, topping up`);
  }
  result.workspace_id = wsId;
  const ws = `/workspaces/${wsId}`;

  // 2. A fake studio of eleven people on the Free plan's two seats would refuse its own invites.
  const entitlements = app.get(EntitlementsService);
  const ownerRow = ok<Array<{ user_id: string; user: { email: string | null } }>>(await call('GET', `${ws}/members`, undefined, token), 'list members').find((m) => m.user?.email?.toLowerCase() === maya.email);
  if (!ownerRow) throw new Error('the workspace creator has no membership');
  const ownerId = ownerRow.user_id;
  if (!(await entitlements.getOverride(wsId))) {
    await entitlements.setOverride(wsId, ownerId, { includedSeats: 25 }, 'Pinewood Studio is a fake agency seeded by seed:agency; it needs more than the Free plan seats', null);
  }

  // 3. The three packs, each into its own space, once.
  const spacesNow = async () => ok<Array<{ id: string; name: string }>>(await call('GET', `${ws}/spaces`, undefined, token), 'list spaces');
  for (const pack of PACKS) {
    if ((await spacesNow()).some((s) => s.name === pack.space)) continue;
    const entry = ok<{ manifest: unknown }>(await call('GET', `/packs/registry/${pack.slug}`, undefined, token), `read pack ${pack.slug}`);
    // The packs ship "(sample)" rows (Acme Co, JCM...). They would sit beside the studio's own clients and read as a template, not an agency.
    const manifest = { ...(entry.manifest as Record<string, unknown>), sample_records: [] };
    ok(await call('POST', `${ws}/packs/install`, { manifest }, token), `install pack ${pack.slug}`);
    result.packs_installed++;
    log(`  pack ${pack.slug} installed`);
  }
  const spaceIds = new Map((await spacesNow()).map((s) => [s.name, s.id]));
  const clientSpace = spaceIds.get('Client Work');
  if (!clientSpace) throw new Error('the Agency OS pack did not create a "Client Work" space');

  // 4. The two databases the packs do not carry.
  const listDatabases = async () =>
    ok<Array<{ id: string; name: string; space_id?: string; spaceId?: string }>>(await call('GET', `${ws}/databases`, undefined, token), 'list databases');
  for (const extra of EXTRA_DATABASES) {
    if ((await listDatabases()).some((d) => d.name === extra.name && (d.space_id ?? d.spaceId) === clientSpace)) continue;
    const made = ok<{ id: string }>(
      await call('POST', `${ws}/databases`, { space_id: clientSpace, name: extra.name, description: extra.description }, token),
      `create database ${extra.name}`,
    );
    for (const f of extra.fields) {
      ok(
        await call(
          'POST',
          `${ws}/databases/${made.id}/fields`,
          {
            display_name: f.name,
            type: f.type,
            config: {},
            ...('options' in f ? { options: f.options.map((label) => ({ label })) } : {}),
          },
          token,
        ),
        `create field ${f.name} on ${extra.name}`,
      );
    }
    result.databases_created++;
    log(`  database ${extra.name} created`);
  }

  const dbRefs = new Map<string, DbRef>();
  const dbRef = async (space: string, name: string): Promise<DbRef> => {
    const key = `${space}/${name}`;
    const cached = dbRefs.get(key);
    if (cached) return cached;
    const spaceId = spaceIds.get(space) ?? (await spacesNow()).find((s) => s.name === space)?.id;
    const found = (await listDatabases()).find((d) => d.name === name && (d.space_id ?? d.spaceId) === spaceId);
    if (!found) throw new Error(`no database "${name}" in space "${space}"`);
    return refreshRef(key, found.id);
  };
  const refreshRef = async (key: string, id: string): Promise<DbRef> => {
    const detail = ok<{ fields: Array<{ id: string; displayName: string; apiName: string; type: string; options?: Array<{ id: string; label: string }> }> }>(
      await call('GET', `${ws}/databases/${id}`, undefined, token),
      'get database',
    );
    const ref: DbRef = { id, fields: new Map(), options: new Map() };
    for (const f of detail.fields) {
      ref.fields.set(f.displayName, { id: f.id, apiName: f.apiName, type: f.type });
      for (const o of f.options ?? []) ref.options.set(`${f.apiName}:${o.label}`, o.id);
    }
    dbRefs.set(key, ref);
    return ref;
  };

  // 5. Invoices belong to a client: the one relation the packs do not already give us.
  const invoices = await dbRef('Client Work', 'Invoices');
  const clientsDb = await dbRef('Client Work', 'Clients');
  if (!invoices.fields.has('Client')) {
    const made = await call('POST', `${ws}/relations`, {
      database_a_id: invoices.id, database_b_id: clientsDb.id, cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Invoices',
    }, token);
    if (made.status !== 409 && made.status !== 422) ok(made, 'relate invoices to clients');
    await refreshRef('Client Work/Invoices', invoices.id);
    await refreshRef('Client Work/Clients', clientsDb.id);
  }

  // 6. The people. Accounts first, then membership (invite + accept, as a real person would).
  const memberRows = async () =>
    ok<Array<{ user_id: string; role: string; user: { email: string | null } }>>(await call('GET', `${ws}/members`, undefined, token), 'list members');
  const userIdByKey = new Map<string, string>();
  const everyone = [...STUDIO_CAST, ...AGENT_LOGINS];
  for (const person of everyone) {
    if (person.key === 'maya') continue;
    const acct = await signUpOrIn(call, person, opts.password);
    if (acct.created) result.people_created++;
    const have = (await memberRows()).find((m) => m.user?.email?.toLowerCase() === person.email);
    if (have) continue;
    const grants = person.role === 'guest' ? [{ space_id: clientSpace, role: 'commenter' }] : undefined;
    const invite = await call('POST', `${ws}/invites`, { email: person.email, role: person.role, ...(grants ? { grants } : {}) }, token);
    if (invite.status >= 300) throw new Error(`invite ${person.email} failed (${invite.status}): ${JSON.stringify(invite.body)}`);
    const inviteToken = new URL((invite.body as { accept_url: string }).accept_url).searchParams.get('token');
    if (!inviteToken) throw new Error('invite carried no token in accept_url');
    ok(await call('POST', '/invites/accept', { token: inviteToken }, acct.token), `accept invite for ${person.email}`);
    result.members_invited++;
  }
  for (const m of await memberRows()) {
    const person = everyone.find((p) => p.email === m.user?.email?.toLowerCase());
    if (person) userIdByKey.set(person.key, m.user_id);
  }

  // 7. Records.
  const resolveValue = (ref: DbRef, display: string, value: unknown): unknown => {
    const field = ref.fields.get(display);
    if (!field) throw new Error(`no field "${display}" (the pack or database changed shape?)`);
    const optionOf = (label: string) => ref.options.get(`${field.apiName}:${label}`);
    if (typeof value === 'string' && value.startsWith('@')) {
      const id = userIdByKey.get(value.slice(1));
      if (!id) throw new Error(`no member for ${value}`);
      return id;
    }
    if (Array.isArray(value)) return (value as string[]).map((v) => optionOf(v) ?? v);
    if (typeof value === 'string' && optionOf(value)) return optionOf(value);
    return value;
  };

  const titlesIn = async (dbId: string): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = ok<{ data: Array<{ id: string; title?: string; values?: Record<string, unknown> }>; next_cursor: string | null }>(
        await call('POST', `${ws}/databases/${dbId}/records/query`, { limit: 200, cursor }, token),
        'page records',
      );
      for (const r of page.data) out.set(String(r.title ?? r.values?.name ?? ''), r.id);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  };

  const idsByTitle = new Map<string, Map<string, string>>();
  const linkLater: Array<{ ref: DbRef; id: string; links: Record<string, string[]> }> = [];
  const ensureRecords = async (space: string, dbName: string, planned: PlannedRecord[]) => {
    const ref = await dbRef(space, dbName);
    const have = await titlesIn(ref.id);
    const missing = planned.filter((p) => !have.has(p.title));
    for (let i = 0; i < missing.length; i += 50) {
      const slice = missing.slice(i, i + 50);
      const payload = slice.map((r) => {
        const values: Record<string, unknown> = { name: r.title };
        for (const [display, v] of Object.entries(r.values)) values[ref.fields.get(display)?.apiName ?? display] = resolveValue(ref, display, v);
        return { values };
      });
      const made = ok<{ data: Array<{ id: string }> }>(
        await call('POST', `${ws}/databases/${ref.id}/records/batch`, { records: payload }, token),
        `create records in ${dbName}`,
      );
      // Backdate to a believable daytime (UTC 09:00-16:59, spread by index), once, as apply.ts does.
      await backdate(
        db,
        made.data.map((r) => r.id),
        slice.map((r, n) => {
          const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - r.createdDaysAgo, 9 + ((i + n) * 3) % 8, ((i + n) * 17) % 60));
          return { created: at, updated: at };
        }),
      );
      slice.forEach((r, n) => have.set(r.title, made.data[n]!.id));
      result.records_created += made.data.length;
      for (let n = 0; n < slice.length; n++) {
        const r = slice[n]!;
        if (r.links) linkLater.push({ ref, id: made.data[n]!.id, links: r.links });
      }
    }
    idsByTitle.set(`${space}/${dbName}`, have);
    result.counts[`${space}/${dbName}`] = have.size;
    log(`  ${space} / ${dbName}: ${have.size} records (${missing.length} added)`);
  };

  // Order matters: a link needs the record on the other end to exist.
  await ensureRecords('Client Work', 'Clients', data.clients);
  await ensureRecords('Client Work', 'Contacts', data.contacts);
  await ensureRecords('Client Work', 'Enquiries', data.enquiries);
  await ensureRecords('Client Work', 'Projects', data.projects);
  await ensureRecords('Client Work', 'Tasks', data.tasks);
  await ensureRecords('Client Work', 'Invoices', data.invoices);
  await ensureRecords('Sales', 'Quotes', data.quotes);
  await ensureRecords('Team', 'Tasks', data.teamTasks);

  // The target of each relation field is a different database; find it by the title the plan named.
  const targetDbFor: Record<string, string> = { Client: 'Clients', Project: 'Projects' };
  for (const pending of linkLater) {
    for (const [fieldName, titles] of Object.entries(pending.links)) {
      const field = pending.ref.fields.get(fieldName);
      if (!field) throw new Error(`no relation field "${fieldName}"`);
      const targets = idsByTitle.get(`Client Work/${targetDbFor[fieldName]}`);
      const ids = titles.map((t) => targets?.get(t)).filter((x): x is string => Boolean(x));
      if (ids.length !== titles.length) throw new Error(`could not resolve ${titles.join(', ')} for ${fieldName}`);
      ok(await call('POST', `${ws}/databases/${pending.ref.id}/records/${pending.id}/links/${field.id}`, { record_ids: ids }, token), `link ${fieldName}`);
      result.links_created += ids.length;
    }
  }

  // 8. Comments written by agents, through a real agent token (so each reads as `source: agent`).
  await applyAgentComments(call, ws, wsId, token, data, idsByTitle, result, log);

  // 9. One pending approval, raised by a real automation rule's real gate.
  await applyApproval(call, ws, token, data, idsByTitle, dbRef, result, opts.approvalWaitMs ?? 20_000, log);

  return result;
}

async function applyAgentComments(
  call: Injector, ws: string, wsId: string, token: string, data: AgencyData,
  idsByTitle: Map<string, Map<string, string>>, result: AgencyResult, log: (m: string) => void,
) {
  const where = { Clients: 'Client Work/Clients', Tasks: 'Client Work/Tasks', Projects: 'Client Work/Projects' } as const;
  const dbIds = new Map<string, string>();
  const dbs = ok<Array<{ id: string; name: string }>>(await call('GET', `${ws}/databases`, undefined, token), 'list databases');
  const clientWork = ok<Array<{ id: string; name: string }>>(await call('GET', `${ws}/spaces`, undefined, token), 'spaces').find((s) => s.name === 'Client Work');
  for (const d of dbs as Array<{ id: string; name: string; space_id?: string; spaceId?: string }>) {
    if ((d.space_id ?? d.spaceId) === clientWork?.id) dbIds.set(d.name, d.id);
  }

  const toWrite: AgencyData['agentComments'] = [];
  for (const c of data.agentComments) {
    const dbId = dbIds.get(c.database);
    const recId = idsByTitle.get(where[c.database])?.get(c.record);
    if (!dbId || !recId) throw new Error(`cannot place the agent comment on ${c.database} / ${c.record}`);
    const list = ok<{ data: Array<{ body: unknown }> }>(await call('GET', `${ws}/databases/${dbId}/records/${recId}/comments`, undefined, token), 'list comments');
    if (!list.data.some((x) => plain(x.body).includes(c.text))) toWrite.push(c);
  }
  if (toWrite.length === 0) return;

  const ensured = ok<{ agentsDb: { id: string } }>(await call('POST', `${ws}/agents/ensure`, undefined, token), 'ensure agents');
  const agentsDbId = ensured.agentsDb.id;
  const existing = ok<{ data: Array<{ id: string; title?: string }> }>(
    await call('POST', `${ws}/databases/${agentsDbId}/records/query`, { limit: 200 }, token),
    'list agents',
  );
  for (const name of [...new Set(toWrite.map((c) => c.agent))]) {
    let agentId = existing.data.find((a) => a.title === name)?.id;
    if (!agentId) {
      agentId = ok<{ id: string }>(await call('POST', `${ws}/databases/${agentsDbId}/records`, { values: { name, enabled: true } }, token), `create agent ${name}`).id;
    }
    const minted = ok<{ token: string; id?: string }>(
      await call('POST', '/me/tokens', { name: `seed:agency ${name}`, workspace_id: wsId, scope: 'write', agent_id: agentId }, token),
      'mint agent token',
    );
    try {
      for (const c of toWrite.filter((x) => x.agent === name)) {
        const dbId = dbIds.get(c.database)!;
        const recId = idsByTitle.get(where[c.database])!.get(c.record)!;
        ok(await call('POST', `${ws}/databases/${dbId}/records/${recId}/comments`, { body: [{ type: 'text', text: c.text }] }, minted.token), 'agent comment');
        result.agent_comments_created++;
      }
    } finally {
      // The token only exists to write these comments. Revoke it so re-runs do not accumulate live credentials.
      if (minted.id) await call('DELETE', `/me/tokens/${minted.id}`, undefined, token);
    }
  }
  log(`  agent comments: +${result.agent_comments_created}`);
}

async function applyApproval(
  call: Injector, ws: string, token: string, data: AgencyData, idsByTitle: Map<string, Map<string, string>>,
  dbRef: (space: string, name: string) => Promise<DbRef>, result: AgencyResult, waitMs: number, log: (m: string) => void,
) {
  const quotes = await dbRef('Sales', 'Quotes');
  const rules = ok<Array<{ name: string }> | { data: Array<{ name: string }> }>(await call('GET', `${ws}/databases/${quotes.id}/automations`, undefined, token), 'list automations');
  const ruleList = Array.isArray(rules) ? rules : rules.data;
  const pendingNow = async () => {
    const res = ok<Array<{ status: string; record_id?: string; recordId?: string }> | { data: Array<{ status: string; record_id?: string; recordId?: string }> }>(
      await call('GET', `${ws}/approvals?status=pending`, undefined, token), 'list approvals');
    return Array.isArray(res) ? res : res.data;
  };
  const alreadyHaveRule = ruleList.some((r) => r.name === data.approval.ruleName);
  if (!alreadyHaveRule) {
    ok(
      await call('POST', `${ws}/databases/${quotes.id}/automations`, {
        name: data.approval.ruleName,
        trigger: { type: 'record_created' },
        actions: [{ type: 'add_comment', body_template: data.approval.commentTemplate, require_approval: true }],
      }, token),
      'create approval-gated rule',
    );
  }
  // The rule fires on creation, so the trigger quote is created AFTER the rule and only when it is not there yet.
  const have = idsByTitle.get('Sales/Quotes')!;
  if (!have.has(data.approval.quote.title)) {
    const payload: Record<string, unknown> = { name: data.approval.quote.title };
    for (const [k, v] of Object.entries(data.approval.quote.values)) payload[quotes.fields.get(k)!.apiName] = v;
    const made = ok<{ id: string }>(await call('POST', `${ws}/databases/${quotes.id}/records`, { values: payload }, token), 'create the trigger quote');
    have.set(data.approval.quote.title, made.id);
    result.records_created++;
    result.counts['Sales/Quotes'] = have.size;
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const pending = await pendingNow();
    if (pending.length > 0) { result.approval_pending = true; break; }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`  approval: ${result.approval_pending ? 'one pending' : 'NONE PENDING after waiting'}`);
}
