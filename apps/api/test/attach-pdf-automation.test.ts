import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authed, signUpUser } from './helpers/users';
import { grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { activityEvents, attachments, automationRuns, automations, databases, records } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';
import { PdfRenderer } from '../src/documents/export/pdf-renderer';

/**
 * Ticket #877 — the `attach_pdf` automation action, end to end against a real Postgres and a STUB of the PDF sidecar.
 *
 * What the stub does and does not prove: everything on OUR side of the wire (who may be rendered, what HTML is posted, what is
 * attached and under which name and actor, and what happens when the renderer is slow, broken or absent). It does NOT prove
 * Chromium lays the page out well; a real render is a separate, manual check. NO test here reaches a real renderer.
 *
 * The access claims are asserted against the PRODUCED ARTEFACT, not against the request: "refused" means the sidecar was never
 * sent the record's content (`received` did not grow) AND no attachment row exists.
 *
 * `env()` is read when the app is imported, so the renderer URL and the limits are set BEFORE the dynamic import.
 */
let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let owner: { token: string; email: string };
let ownerId: string;
let wsId: string;
let spaceId: string;

let sidecar: Server;
let received: string[] = [];
let mode: 'ok' | 'slow' | 'broken' | 'big' = 'ok';

const BOUNDARY = /boundary=(.+)$/;
function readBody(req: IncomingMessage): Promise<Buffer> {
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  })();
}
function htmlOf(body: Buffer, contentType: string): string {
  const boundary = BOUNDARY.exec(contentType)?.[1] ?? '';
  for (const part of body.toString('utf8').split(`--${boundary}`)) {
    if (/name="files"; filename="index.html"/i.test(part)) return part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  }
  return '';
}

async function call(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
}
const asOwner = (method: string, url: string, payload?: unknown) => call(owner.token, method, url, payload);

beforeAll(async () => {
  sidecar = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"up"}');
      return;
    }
    if (req.method === 'POST' && req.url === '/forms/chromium/convert/html') {
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 3500));
      received.push(htmlOf(body, String(req.headers['content-type'] ?? '')));
      if (mode === 'broken') {
        res.writeHead(500).end('boom: /srv/internal/path');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(mode === 'big' ? `%PDF${'x'.repeat(6000)}` : '%PDF-1.4 stub');
      return;
    }
    res.writeHead(404).end();
  });
  const port = await new Promise<number>((resolve) => sidecar.listen(0, '127.0.0.1', () => resolve((sidecar.address() as AddressInfo).port)));
  process.env.PDF_RENDERER_URL = `http://127.0.0.1:${port}`;
  process.env.PDF_RENDER_TIMEOUT_MS = '2000';
  process.env.ATTACHMENT_MAX_BYTES = '5000';

  const { createTestApp } = await import('./helpers/app');
  app = await createTestApp();
  db = app.get<Db>(DB);
  engine = app.get(AutomationsService);
  owner = await signUpUser(app, 'AttachPdfOwner');
  wsId = (await asOwner('POST', '/workspaces', { name: 'Attach PDF WS' })).json().id;
  spaceId = (await asOwner('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  ownerId = (await asOwner('GET', '/me')).json().id;
});

afterAll(async () => {
  await app?.close();
  sidecar?.close();
});

interface Fixture {
  quotes: string;
  clients: string;
  filesField: string;
  filesApi: string;
  notesField: string;
  notesApi: string;
  relField: string;
  relApi: string;
}

/** A fresh Quotes database (Files attachment field, Notes text, a relation to a fresh Clients database), so one test's rules never fire on another's records. */
async function fixture(): Promise<Fixture> {
  const quotes = (await asOwner('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Quotes ${randomUUID()}` })).json().id as string;
  const clients = (await asOwner('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Clients ${randomUUID()}` })).json().id as string;
  const files = (await asOwner('POST', `/workspaces/${wsId}/databases/${quotes}/fields`, { display_name: 'Files', type: 'attachment', config: {} })).json();
  const notes = (await asOwner('POST', `/workspaces/${wsId}/databases/${quotes}/fields`, { display_name: 'Notes', type: 'text', config: {} })).json();
  const rel = (await asOwner('POST', `/workspaces/${wsId}/relations`, { database_a_id: quotes, database_b_id: clients, cardinality: 'many_to_many' })).json();
  return {
    quotes,
    clients,
    filesField: files.id,
    filesApi: files.apiName,
    notesField: notes.id,
    notesApi: notes.apiName,
    relField: rel.field_a.id,
    relApi: rel.field_a.api_name ?? rel.field_a.apiName,
  };
}

async function newRule(token: string, f: Fixture, actions: unknown[], extra: Record<string, unknown> = {}) {
  return call(token, 'POST', `/workspaces/${wsId}/databases/${f.quotes}/automations`, {
    name: `PDF rule ${randomUUID()}`,
    // Scoped to Notes: the attachment write is itself a record_updated (on Files), and an unscoped rule would re-fire on its own output.
    trigger: { type: 'record_updated', field_id: f.notesField },
    actions,
    ...extra,
  });
}

const attachAction = (f: Fixture, over: Record<string, unknown> = {}) => ({
  type: 'attach_pdf',
  source: { kind: 'record' },
  target_field_id: f.filesField,
  ...over,
});

async function newQuote(f: Fixture, title: string, values: Record<string, unknown> = {}): Promise<string> {
  const res = await asOwner('POST', `/workspaces/${wsId}/databases/${f.quotes}/records`, { values: { name: title, ...values } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** How many runs a record has produced, across every rule on it. */
const runCount = async (recordId: string) => (await db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.triggerRecordId, recordId))).length;

/**
 * Touch the record so a record_updated rule fires, then wait until that firing's run row exists and has left 'running'. A run is
 * dispatched off the event bus, so `settle` alone can return before it has finished; reading the artefacts then would race it.
 */
async function fire(f: Fixture, recordId: string, text: string = randomUUID()) {
  const before = await runCount(recordId);
  const res = await asOwner('PATCH', `/workspaces/${wsId}/databases/${f.quotes}/records/${recordId}`, { values: { [f.notesApi]: text } });
  expect(res.statusCode, res.body).toBeLessThan(300);
  await engine.settle(recordId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const runs = await db.select({ status: automationRuns.status }).from(automationRuns).where(eq(automationRuns.triggerRecordId, recordId));
    if (runs.length > before && runs.every((r) => r.status !== 'running')) {
      if (process.env.DEBUG_PDF) console.log('RUNS', JSON.stringify(await db.select({ s: automationRuns.status, e: automationRuns.error, d: automationRuns.depth, ef: automationRuns.effects }).from(automationRuns).where(eq(automationRuns.triggerRecordId, recordId))), 'RECEIVED', received.length);
      return;
    }
    if (Date.now() > deadline) throw new Error(`the run for ${recordId} did not finish`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const filesOf = (recordId: string) => db.select().from(attachments).where(eq(attachments.recordId, recordId));
const lastRun = async (ruleId: string) => (await db.select().from(automationRuns).where(eq(automationRuns.automationId, ruleId)).orderBy(desc(automationRuns.createdAt)).limit(1))[0]!;
const commentsOf = async (f: Fixture, recordId: string) =>
  ((await asOwner('GET', `/workspaces/${wsId}/databases/${f.quotes}/records/${recordId}/comments`)).json().data as Array<{ body: Array<{ text: string }> }>).map((c) => c.body[0]?.text ?? '');

/** A person who can build rules on Quotes but has NO access to Clients: a member on a restricted Quotes (creator grant), Clients restricted and ungranted. */
async function memberWithoutClients(f: Fixture, role: 'member' | 'guest' = 'member'): Promise<Person> {
  await setRestricted(app, owner.token, wsId, 'database', f.quotes);
  await setRestricted(app, owner.token, wsId, 'database', f.clients);
  return joinAs(app, owner.token, wsId, `${role} no clients`, role, [{ database_id: f.quotes, role: 'creator' }]);
}

async function linkClient(f: Fixture, quoteId: string, title: string): Promise<string> {
  const client = (await asOwner('POST', `/workspaces/${wsId}/databases/${f.clients}/records`, { values: { name: title } })).json().id as string;
  const link = await asOwner('POST', `/workspaces/${wsId}/databases/${f.quotes}/records/${quoteId}/links/${f.relField}`, { record_ids: [client] });
  expect(link.statusCode, link.body).toBe(201);
  return client;
}

describe('attach_pdf: the file, its name, its actor (ticket #877)', () => {
  it('attaches a PDF made from the record, named {title} · {date}.pdf, as the rule owner with source "automation"', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    expect(rule.statusCode, rule.body).toBe(201);
    const id = await newQuote(f, 'Quarry Hill tasting room');
    received = [];
    await fire(f, id, 'Net 30');

    const files = await filesOf(id);
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toBe(`Quarry Hill tasting room · ${new Date().toISOString().slice(0, 10)}.pdf`);
    expect(files[0]!.mime).toBe('application/pdf');
    expect(files[0]!.fieldId).toBe(f.filesField);
    expect(files[0]!.uploadedBy).toBe(ownerId);
    // The renderer was sent THIS record, drawn with its title and a visible field.
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('Quarry Hill tasting room');
    expect(received[0]).toContain('Net 30');
    // The record's Files field shows it (the value is the ordered list of attachment ids).
    const rec = (await asOwner('GET', `/workspaces/${wsId}/databases/${f.quotes}/records/${id}`)).json();
    expect(JSON.stringify(rec.values[f.filesApi])).toContain(files[0]!.id);
    // Audit: the actor is the owner and the source is the automation, not a human click.
    const events = await db.select().from(activityEvents).where(and(eq(activityEvents.recordId, id), eq(activityEvents.type, 'attachment.added')));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(ownerId);
    expect(events[0]!.source).toBe('automation');
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('ok');
    expect(JSON.stringify(run.effects)).toContain('Attached');
  });

  it('a filename template is merge-fielded and made safe: no path separators, no traversal, capped, always .pdf', async () => {
    const f = await fixture();
    await newRule(owner.token, f, [attachAction(f, { filename_template: `{Notes}/{Title}` })]);
    const id = await newQuote(f, 'Contract');
    await fire(f, id, '../../etc/passwd');
    const files = await filesOf(id);
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).not.toMatch(/[\\/]/);
    expect(files[0]!.filename).not.toContain('..');
    expect(files[0]!.filename.endsWith('.pdf')).toBe(true);
    expect(files[0]!.filename).toContain('Contract');

    const g = await fixture();
    await newRule(owner.token, g, [attachAction(g, { filename_template: '{Notes}' })]);
    const long = await newQuote(g, 'Long');
    await fire(g, long, 'x'.repeat(900));
    expect((await filesOf(long))[0]!.filename.length).toBeLessThanOrEqual(124);
  });

  it('other actions are untouched and still run, in order, after a successful attach_pdf', async () => {
    const f = await fixture();
    await newRule(owner.token, f, [attachAction(f), { type: 'add_comment', body_template: 'after the pdf: {Title}' }]);
    const id = await newQuote(f, 'Order check');
    await fire(f, id);
    expect(await filesOf(id)).toHaveLength(1);
    expect(await commentsOf(f, id)).toContain('after the pdf: Order check');
  });
});

describe('attach_pdf: a re-run does not attach twice unless configured (ticket #877)', () => {
  it('skip (the default): a second firing of the same trigger attaches nothing and renders nothing', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f, { filename_template: 'Same name' })]);
    const id = await newQuote(f, 'Dup check');
    await fire(f, id);
    received = [];
    await fire(f, id);
    expect(await filesOf(id)).toHaveLength(1);
    expect(received).toHaveLength(0);
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('ok');
    expect(JSON.stringify(run.effects)).toContain('already');
  });

  it('add: keeps both. replace: swaps the old file for the new one, leaving exactly one', async () => {
    const f = await fixture();
    await newRule(owner.token, f, [attachAction(f, { filename_template: 'Added', if_exists: 'add' })]);
    const a = await newQuote(f, 'Add mode');
    await fire(f, a);
    await fire(f, a);
    expect(await filesOf(a)).toHaveLength(2);

    const g = await fixture();
    await newRule(owner.token, g, [attachAction(g, { filename_template: 'Replaced', if_exists: 'replace' })]);
    const b = await newQuote(g, 'Replace mode');
    await fire(g, b);
    const first = (await filesOf(b))[0]!.id;
    await fire(g, b);
    const after = await filesOf(b);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(first);
  });
});

describe('attach_pdf: the rule owner\'s access, checked at run time (ticket #877)', () => {
  it('a linked record the owner cannot read is NOT rendered and nothing is attached; granting access makes the same rule work', async () => {
    const f = await fixture();
    const maker = await memberWithoutClients(f);
    const rule = await newRule(maker.token, f, [attachAction(f, { source: { kind: 'linked_record', relation_field_id: f.relField } })]);
    expect(rule.statusCode, rule.body).toBe(201);
    const id = await newQuote(f, 'Quote with a client');
    await linkClient(f, id, 'SECRET CLIENT CONTRACT');

    received = [];
    await fire(f, id);
    // The artefact: the sidecar never saw the record, and no file exists.
    expect(received.join('')).not.toContain('SECRET CLIENT CONTRACT');
    expect(received).toHaveLength(0);
    expect(await filesOf(id)).toHaveLength(0);
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('error');
    expect(run.error).toContain('No PDF was made');
    expect(run.error).toContain('cannot read');
    // The refusal says who and what KIND of thing; it does not leak the unreadable record's title.
    expect(run.error).not.toContain('SECRET CLIENT CONTRACT');

    // Positive control: with read access on Clients the same rule renders it, so the refusal above was the access rule and not a broken fixture.
    await grant(app, owner.token, wsId, maker.id, { database_id: f.clients }, 'viewer');
    await fire(f, id);
    expect(await filesOf(id)).toHaveLength(1);
    expect(received.join('')).toContain('SECRET CLIENT CONTRACT');
  });

  it('a rule whose owner is now a GUEST with no access to the source is refused (the run-time re-check, not the save-time one)', async () => {
    const f = await fixture();
    const guest = await memberWithoutClients(f, 'guest');
    // A guest cannot be the one to author rules here; model "the creator lost access since" by handing the rule to the guest.
    const rule = await newRule(owner.token, f, [attachAction(f, { source: { kind: 'linked_record', relation_field_id: f.relField } })]);
    await db.update(automations).set({ createdBy: guest.id }).where(eq(automations.id, (rule.json() as { id: string }).id));
    const id = await newQuote(f, 'Guest-owned');
    await linkClient(f, id, 'NOT FOR GUESTS');
    received = [];
    await fire(f, id);
    expect(received).toHaveLength(0);
    expect(await filesOf(id)).toHaveLength(0);
    expect((await lastRun((rule.json() as { id: string }).id)).status).toBe('error');
  });

  it('an owner who can read the record but cannot EDIT it cannot have a file attached to it', async () => {
    const f = await fixture();
    const reader = await joinAs(app, owner.token, wsId, 'reader only', 'member');
    await setRestricted(app, owner.token, wsId, 'database', f.quotes);
    await grant(app, owner.token, wsId, reader.id, { database_id: f.quotes }, 'viewer');
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    await db.update(automations).set({ createdBy: reader.id }).where(eq(automations.id, (rule.json() as { id: string }).id));
    const id = await newQuote(f, 'Read only owner');
    received = [];
    await fire(f, id);
    expect(received).toHaveLength(0);
    expect(await filesOf(id)).toHaveLength(0);
    expect((await lastRun((rule.json() as { id: string }).id)).error).toContain('cannot edit');
  });

  it('a rule with no creator, or a creator who is no longer a member, makes nothing', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    const ruleId = (rule.json() as { id: string }).id;
    await db.update(automations).set({ createdBy: null }).where(eq(automations.id, ruleId));
    const id = await newQuote(f, 'Ownerless');
    received = [];
    await fire(f, id);
    expect(received).toHaveLength(0);
    expect(await filesOf(id)).toHaveLength(0);
    expect((await lastRun(ruleId)).error).toContain('no owner');
  });

  it('the failing action stops the rule: a later action does not run, so nothing is sent without its attachment', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f, { source: { kind: 'linked_record', relation_field_id: f.relField } }), { type: 'add_comment', body_template: 'SENT ANYWAY' }]);
    const id = await newQuote(f, 'No link here');
    await fire(f, id);
    expect((await lastRun((rule.json() as { id: string }).id)).status).toBe('error');
    expect(await commentsOf(f, id)).not.toContain('SENT ANYWAY');
  });

  it('a relation holding several records is refused rather than guessing one; none is refused too', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f, { source: { kind: 'linked_record', relation_field_id: f.relField } })]);
    const ruleId = (rule.json() as { id: string }).id;
    const id = await newQuote(f, 'Ambiguous');
    await fire(f, id);
    expect((await lastRun(ruleId)).error).toContain('nothing in');
    await linkClient(f, id, 'One');
    await linkClient(f, id, 'Two');
    received = [];
    await fire(f, id);
    expect((await lastRun(ruleId)).error).toContain('exactly one');
    expect(received).toHaveLength(0);
    expect(await filesOf(id)).toHaveLength(0);
  });
});

describe('attach_pdf: save-time validation (ticket #877)', () => {
  it('422s a target that is not an attachment field, is unknown, or lives on another database', async () => {
    const f = await fixture();
    const g = await fixture();
    for (const [label, over] of [
      ['text field', { target_field_id: (await asOwner('GET', `/workspaces/${wsId}/databases/${f.quotes}`)).json().fields.find((x: { apiName: string }) => x.apiName === f.notesApi).id }],
      ['unknown', { target_field_id: randomUUID() }],
      ['other database', { target_field_id: g.filesField }],
    ] as const) {
      const res = await newRule(owner.token, f, [attachAction(f, over)]);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(422);
    }
  });

  it('422s a relation source that is not a relation field of this database', async () => {
    const f = await fixture();
    const res = await newRule(owner.token, f, [attachAction(f, { source: { kind: 'linked_record', relation_field_id: f.filesField } })]);
    expect(res.statusCode, res.body).toBe(422);
    const other = await newRule(owner.token, f, [attachAction(f, { source: { kind: 'linked_record', relation_field_id: randomUUID() } })]);
    expect(other.statusCode, other.body).toBe(422);
  });

  it('422s require_approval (there is nothing to hold), a malformed if_exists, and a webhook-triggered rule (no record)', async () => {
    const f = await fixture();
    expect((await newRule(owner.token, f, [attachAction(f, { require_approval: true })])).statusCode).toBe(422);
    expect((await newRule(owner.token, f, [attachAction(f, { if_exists: 'overwrite' })])).statusCode).toBeGreaterThanOrEqual(400);
    const hook = await newRule(owner.token, f, [attachAction(f)], { trigger: { type: 'webhook_received' } });
    expect(hook.statusCode, hook.body).toBe(422);
  });

  it('a SYSTEM database is never rendered or written: refused at save, and refused at run time if the flag arrives later', async () => {
    const f = await fixture();
    const live = await newRule(owner.token, f, [attachAction(f)]);
    expect(live.statusCode, live.body).toBe(201);
    const id = await newQuote(f, 'Becomes system');
    // The people / agents databases carry is_system; flip it on this one to stand in for them.
    await db.update(databases).set({ isSystem: true }).where(eq(databases.id, f.quotes));
    const authoring = await newRule(owner.token, f, [attachAction(f)]);
    expect(authoring.statusCode, authoring.body).toBe(422);
    expect(authoring.body).toContain('system database');
    received = [];
    await fire(f, id);
    expect(received).toHaveLength(0);
    expect(await filesOf(id)).toHaveLength(0);
    expect((await lastRun((live.json() as { id: string }).id)).error).toContain('system database');
  });
});

describe('attach_pdf: failures are recorded, never thrown, and leave nothing behind (ticket #877)', () => {
  it('a renderer that is too slow fails the run with a plain message; nothing attached; the next firing still works', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    const ruleId = (rule.json() as { id: string }).id;
    const id = await newQuote(f, 'Slow');
    mode = 'slow';
    try {
      await fire(f, id);
    } finally {
      mode = 'ok';
    }
    const run = await lastRun(ruleId);
    expect(run.status).toBe('error');
    expect(run.error).toContain('too long');
    expect(await filesOf(id)).toHaveLength(0);
    await fire(f, id);
    expect(await filesOf(id)).toHaveLength(1);
    // The stub answers the abandoned request late; let it land before the next test counts renders.
    await new Promise((r) => setTimeout(r, 2000));
  }, 20_000);

  it('a renderer that errors fails the run with a generic message that does not echo the renderer\'s own text', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    const id = await newQuote(f, 'Broken');
    mode = 'broken';
    try {
      await fire(f, id);
    } finally {
      mode = 'ok';
    }
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('error');
    expect(run.error).toContain('No PDF was made');
    expect(run.error).not.toContain('/srv/internal');
    expect(await filesOf(id)).toHaveLength(0);
  });

  it('a PDF over the attachment size limit is refused before anything is written', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    const id = await newQuote(f, 'Too big');
    mode = 'big';
    try {
      await fire(f, id);
    } finally {
      mode = 'ok';
    }
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('error');
    expect(run.error).toContain('at most');
    expect(await filesOf(id)).toHaveLength(0);
    // And no half-made row: a row with a pending storage key would be a partial attachment.
    const rows = await db.select({ id: records.id }).from(records).where(eq(records.id, id));
    expect(rows).toHaveLength(1);
  });
});

describe('attach_pdf: loops and half-written files (ticket #877)', () => {
  it('a rule on ANY update that attaches in add mode re-fires on its own file, but the loop guard stops it (bounded, not runaway)', async () => {
    const f = await fixture();
    await newRule(owner.token, f, [attachAction(f, { filename_template: 'Loop', if_exists: 'add' })], { trigger: { type: 'record_updated' } });
    const id = await newQuote(f, 'Loop check');
    await fire(f, id);
    await new Promise((r) => setTimeout(r, 400));
    const n = (await filesOf(id)).length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
    // The same rule in the default mode stops at one: the second firing finds the file by name.
    const g = await fixture();
    await newRule(owner.token, g, [attachAction(g, { filename_template: 'Loop' })], { trigger: { type: 'record_updated' } });
    const other = await newQuote(g, 'Loop check skip');
    await fire(g, other);
    await new Promise((r) => setTimeout(r, 400));
    expect(await filesOf(other)).toHaveLength(1);
  });

  it('a storage failure while writing the file leaves no half-made attachment row behind', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    const id = await newQuote(f, 'Storage fails');
    const { getStorage } = await import('../src/attachments/storage');
    const storage = getStorage();
    const original = storage.put.bind(storage);
    storage.put = async () => {
      throw new Error('disk full /var/data');
    };
    try {
      await fire(f, id);
    } finally {
      storage.put = original;
    }
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('error');
    expect(run.error).not.toContain('/var/data');
    expect(await filesOf(id)).toHaveLength(0);
  });
});

describe('attach_pdf: queue wiring and linked system sources (ticket #877)', () => {
  it('renders through the per-workspace queue (this workspace, limit 25), never through the interactive path', async () => {
    const f = await fixture();
    await newRule(owner.token, f, [attachAction(f)]);
    const id = await newQuote(f, 'Queue wiring');
    const renderer = app.get(PdfRenderer);
    const original = renderer.render.bind(renderer);
    const seen: unknown[] = [];
    renderer.render = (async (html: string, queue?: unknown) => {
      seen.push(queue);
      return original(html, queue as never);
    }) as typeof renderer.render;
    try {
      await fire(f, id);
    } finally {
      renderer.render = original;
    }
    expect(seen).toEqual([{ key: wsId, limit: 25 }]);
  });

  it('a past-the-limit refusal is a recorded failure with the figure in the sentence, and nothing is attached', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    const id = await newQuote(f, 'Queue full');
    const renderer = app.get(PdfRenderer);
    const original = renderer.render.bind(renderer);
    renderer.render = (async (html: string, queue?: { limit: number }) => original(html, { key: 'full-test-key', limit: 0, ...(queue ? {} : {}) })) as typeof renderer.render;
    try {
      await fire(f, id);
    } finally {
      renderer.render = original;
    }
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('error');
    expect(run.error).toContain('Too many PDFs are waiting');
    expect(await filesOf(id)).toHaveLength(0);
  });

  it('a linked record that lives in a system database is never rendered, even when the owner could otherwise read it', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f, { source: { kind: 'linked_record', relation_field_id: f.relField } })]);
    const id = await newQuote(f, 'Links a system record');
    await linkClient(f, id, 'SYSTEM ROW');
    await db.update(databases).set({ isSystem: true }).where(eq(databases.id, f.clients));
    received = [];
    await fire(f, id);
    expect(received).toHaveLength(0);
    expect(await filesOf(id)).toHaveLength(0);
    expect((await lastRun((rule.json() as { id: string }).id)).error).toContain('never made from');
  });
});

describe('attach_pdf: no renderer (ticket #877, ruling 4)', () => {
  /** The test process cannot re-import the app with a different env, so the renderer is switched off in place and restored. */
  async function withoutRenderer<T>(run: () => Promise<T>): Promise<T> {
    const renderer = app.get(PdfRenderer) as unknown as { options: { url?: string }; probed?: unknown };
    const url = renderer.options.url;
    renderer.options.url = undefined;
    renderer.probed = undefined;
    try {
      return await run();
    } finally {
      renderer.options.url = url;
      renderer.probed = undefined;
    }
  }

  it('the rule can be SAVED switched off but not created or switched ON, and says why in a sentence', async () => {
    const f = await fixture();
    await withoutRenderer(async () => {
      const on = await newRule(owner.token, f, [attachAction(f)]);
      expect(on.statusCode, on.body).toBe(422);
      expect(on.body).toContain('pdf_export_unavailable');
      expect(on.body).toContain('not set up');
      const off = await newRule(owner.token, f, [attachAction(f)], { enabled: false });
      expect(off.statusCode, off.body).toBe(201);
      const enable = await call(owner.token, 'PATCH', `/workspaces/${wsId}/databases/${f.quotes}/automations/${off.json().id}`, { enabled: true });
      expect(enable.statusCode, enable.body).toBe(422);
    });
  });

  it('a rule already ON fails LOUDLY at run time, runs nothing after it, and attaches nothing', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f), { type: 'add_comment', body_template: 'SENT ANYWAY' }]);
    const id = await newQuote(f, 'No renderer');
    await withoutRenderer(async () => {
      await fire(f, id);
    });
    const run = await lastRun((rule.json() as { id: string }).id);
    expect(run.status).toBe('error');
    expect(run.error).toContain('not configured');
    expect(await filesOf(id)).toHaveLength(0);
    expect(await commentsOf(f, id)).not.toContain('SENT ANYWAY');
  });

  it('switching a rule OFF is always allowed, and a rule without attach_pdf is never judged by the renderer', async () => {
    const f = await fixture();
    const rule = await newRule(owner.token, f, [attachAction(f)]);
    await withoutRenderer(async () => {
      const off = await call(owner.token, 'PATCH', `/workspaces/${wsId}/databases/${f.quotes}/automations/${rule.json().id}`, { enabled: false });
      expect(off.statusCode, off.body).toBe(200);
      const plain = await newRule(owner.token, f, [{ type: 'add_comment', body_template: 'hi' }]);
      expect(plain.statusCode, plain.body).toBe(201);
    });
  });
});
