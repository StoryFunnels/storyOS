import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { creatableFieldTypeSchema, evaluateFormula, packManifestSchema, parseFormula, typecheck } from '@storyos/schemas';
import type { FormulaFieldInfo } from '@storyos/schemas';
import { PACK_REGISTRY, toPublicPreview } from '../src/packs/registry';
import { AutomationsService } from '../src/automations/automations.service';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { call, joinAs } from './helpers/members';
import { signUpUser } from './helpers/users';

/**
 * ticket #1324 - the Lead Follow-up pack: three databases, one link, three views, one automation, one agent with eight stage triggers, and
 * 10 sample records. Checked against the spec's COMPLETE field lists, not a sample of them.
 */
const entry = PACK_REGISTRY.find((p) => p.slug === 'lead-follow-up')!;
const AGENT = 'Lead Follow-up Drafter';
const STAGES = ['New', 'Contacted', 'Call Booked', 'Proposal Sent', 'Negotiating', 'Won', 'Lost', 'Not now'];

const { pool } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown, token?: string) => call(app, token ?? owner.token, method, url, payload);
const newWs = async (n: string) => (await as('POST', '/workspaces', { name: `${n} ${Date.now()}` })).json().id as string;

interface Opt { id: string; label: string; color?: string; category?: string | null }
interface Fld { id: string; displayName: string; apiName: string; type: string; options?: Opt[]; config?: Record<string, unknown> }
interface View { id: string; name: string; type: string; isDefault: boolean; config: Record<string, unknown> }
type Detail = { id: string; fields: Fld[]; views: View[] };
type Row = { id: string; title: string; values: Record<string, unknown> };
const dbsOf = async (ws: string) => ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>).filter((d) => d.name !== 'Members');
const detail = async (ws: string, name: string) => {
  const db = (await dbsOf(ws)).find((d) => d.name === name)!;
  return (await as('GET', `/workspaces/${ws}/databases/${db.id}`)).json() as Detail;
};
const rows = async (ws: string, dbId: string, body: unknown = { limit: 200 }) =>
  ((await as('POST', `/workspaces/${ws}/databases/${dbId}/records/query`, body)).json().data ?? []) as Row[];
const optId = (d: Detail, field: string, label: string) => d.fields.find((f) => f.displayName === field)!.options!.find((o) => o.label === label)!.id;
const install = (ws: string, body: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest, ...body });
const triggerLabel = (stage: string) => `${AGENT} ← Leads.Stage = ${stage}`;
const dayStr = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Lead Follow-up Owner');
}, 240_000);
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Every field of every database the spec lists. The title ("Name") is not listed. */
const SPEC_FIELDS: Record<string, Record<string, string>> = {
  Leads: {
    Stage: 'select', Source: 'select', Company: 'text', 'Contact Email': 'email', Phone: 'text', 'Preferred Channel': 'select', 'WhatsApp Consent': 'checkbox',
    'Consent Note': 'text', 'Do Not Contact': 'checkbox', Interest: 'select', 'Deal Value': 'number', Owner: 'user', 'Last Contact': 'date',
    'Days Since Contact': 'formula', 'Next Step': 'text', 'Next Step Date': 'date', 'Lost Reason': 'select', Notes: 'rich_text', 'Follow-ups': 'relation',
  },
  'Follow-ups': {
    Lead: 'relation', 'Stage At Draft': 'select', Channel: 'select', Subject: 'text', Draft: 'rich_text', Status: 'select', 'Send After': 'date',
    'Approved By': 'user', 'Sent On': 'date', 'Reviewer Note': 'text',
  },
  'Stage Guide': { Stage: 'select', Goal: 'text', 'Must Include': 'rich_text', 'Never Say': 'rich_text', 'Wait Days': 'number', 'Booking Link': 'url', Signature: 'text' },
};

describe('#1324 the manifest', () => {
  const m = entry?.manifest;

  it('is registered and valid, and the registry entry has the spec\'s packs.json shape', () => {
    expect(entry, 'lead-follow-up is not in PACK_REGISTRY').toBeTruthy();
    expect(packManifestSchema.safeParse(m).success).toBe(true);
    expect(entry.slug).toBe('lead-follow-up');
    expect(entry.name).toBe('Lead Follow-up');
    expect(entry.summary).toBe('Leads through a stage pipeline, a stage guide you write, and a drafter that prepares the next message for a person to approve and send.');
    expect(entry.highlights).toEqual([
      'Leads, Follow-ups and Stage Guide, fully related',
      'Lead pipeline: New → Contacted → Call Booked → Proposal Sent → Negotiating → Won / Lost, plus Not now',
      'A "Lead Follow-up Drafter" agent drafts the next message into a Follow-up record: gated, your call to run it',
      'Notifies you when a lead’s stage changes',
    ]);
    expect(m.requires).toEqual({ connections: [], ai: 'byo' });
    expect(toPublicPreview(entry).contents).toEqual({
      databases: ['Leads', 'Follow-ups', 'Stage Guide'],
      views: ['Lead Pipeline', 'Ready for Review', 'Going Quiet'],
      automations: ['Notify on lead stage change'],
      agents: [AGENT],
      skills: [],
    });
  });

  it('uses only field types that exist (the creatable enum), and a text Phone', () => {
    const allowed = new Set<string>(creatableFieldTypeSchema.options);
    const types = m.databases.flatMap((d) => d.fields.map((f) => [`${d.name}.${f.name}`, f.type] as const));
    expect(types.length).toBeGreaterThan(20);
    for (const [name, type] of types) expect(allowed.has(type), `${name}: ${type}`).toBe(true);
    expect(m.databases[0]!.fields.find((f) => f.name === 'Phone')!.type).toBe('text');
  });

  it('the agent: one stage trigger per stage, own AI, gated, drafts only (the instructions carry every guardrail)', () => {
    const a = m.agents[0]!;
    expect(m.agents).toHaveLength(1);
    expect(a.name).toBe(AGENT);
    expect(a.ai_mode).toBe('your_own_ai');
    expect(a.scopes).toEqual(['read', 'write']);
    expect(a.approval_policy).toEqual(['email', 'outward']);
    expect(m.triggers.map((t) => `${t.database}.${t.state_field}=${t.state_option}`)).toEqual(STAGES.map((s) => `Leads.Stage=${s}`));
    expect(m.triggers.every((t) => t.agent === AGENT && t.human_gate === false)).toBe(true);
    // ticket #1324 follow-up: every stage trigger carries the Do Not Contact guard the CODE checks at wake time
    expect(m.triggers.every((t) => JSON.stringify(t.condition) === JSON.stringify({ field: 'do_not_contact', op: 'eq', value: false }))).toBe(true);
    // StoryOS holds the agent's UPDATES to the three databases, so "never changes the lead" is not only the prompt's word
    expect(a.write_gates).toEqual([
      { operations: ['update'], database: 'Leads' },
      { operations: ['update'], database: 'Follow-ups' },
      { operations: ['update'], database: 'Stage Guide' },
    ]);
    const ins = a.instructions!;
    expect(ins.length).toBeLessThanOrEqual(5000);
    for (const must of [
      'You never send anything', 'Do Not Contact is ticked, draft nothing', 'never send, schedule or queue', 'never set a Follow-up to Approved or Sent',
      'never change the lead\'s Stage', 'WhatsApp only when WhatsApp Consent is ticked', 'Never a group', 'say why in Reviewer Note', 'Never invent a price',
      '⟦CALL TIME⟧', 'last chance', 'at most one nudge per stage', 'easy way to say "not now"', 'draft one short close and then nothing more',
    ]) {
      expect(ins, must).toContain(must);
    }
    // every stage has its line
    for (const s of STAGES) expect(ins, s).toMatch(new RegExp(`- ${s}: `));
  });

  it('fake-data audit: every email is on the reserved .example domain, every lead and follow-up says (sample), and no sample uses a real-looking URL', () => {
    const json = JSON.stringify(m);
    const emails = json.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [];
    expect(emails.length, 'the audit would be vacuous without emails').toBeGreaterThanOrEqual(6);
    for (const e of emails) expect(e, e).toMatch(/\.example$/);
    expect(json).not.toMatch(/https?:\/\//);
    for (const r of m.sample_records.filter((x) => x.database !== 'Stage Guide')) expect(String(r.values.name), r.database).toContain('(sample)');
  });

  it('10 + 8 records: 7 leads, 3 follow-ups, and the 8 Stage Guide records are structure, not sample', () => {
    const count = (db: string) => m.sample_records.filter((r) => r.database === db).length;
    expect([count('Leads'), count('Follow-ups'), count('Stage Guide')]).toEqual([7, 3, 8]);
    expect(m.sample_records.filter((r) => r.database === 'Stage Guide').every((r) => r.sample === false)).toBe(true);
    expect(m.sample_records.filter((r) => r.database !== 'Stage Guide').every((r) => r.sample === undefined)).toBe(true);
  });
});

describe('#1324 "Days Since Contact" on a fixed clock (no real time)', () => {
  const expr = (entry.manifest.databases[0]!.fields.find((f) => f.name === 'Days Since Contact')!.config as { expression: string }).expression;
  const FIELDS: FormulaFieldInfo[] = [{ api_name: 'last_contact', display_name: 'Last Contact', formula_type: 'date' }];
  const run = (values: Record<string, unknown>) => {
    const ast = parseFormula(expr, FIELDS);
    typecheck(ast, FIELDS);
    return evaluateFormula(ast, values);
  };

  it('counts the days of silence as a POSITIVE number, null for a lead never contacted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
      expect(run({ last_contact: '2026-11-10' })).toBe(9);
      expect(run({ last_contact: '2026-11-19' })).toBe(0);
      expect(run({ last_contact: '2026-10-20' })).toBe(30);
      expect(run({ last_contact: null })).toBeNull();
      expect(run({})).toBeNull();
      // the order matters: days_between(today(), {Last Contact}) would be -9 for the first case
      const reversed = parseFormula('days_between(today(), {Last Contact})', FIELDS);
      typecheck(reversed, FIELDS);
      expect(evaluateFormula(reversed, { last_contact: '2026-11-10' })).toBe(-9);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#1324 installs on a fresh workspace', () => {
  let ws: string;
  let out: {
    databases: Array<{ name: string; action: string }>;
    views: unknown[];
    agents: Array<{ name: string; action: string }>;
    automations: Array<{ name: string; action: string; enabled?: boolean }>;
    triggers: Array<{ name: string; action: string; enabled?: boolean; switched_off_because?: string; human_gate?: boolean }>;
    sample_records: Array<{ action: string }>;
    unmet: unknown[];
  };

  beforeAll(async () => {
    ws = await newWs('Fresh');
    const res = await install(ws);
    expect(res.statusCode, res.body).toBe(201);
    out = res.json();
  }, 120_000);

  it('creates exactly the declared databases, view, automation and agent, nothing unmet', async () => {
    expect(out.unmet).toEqual([]);
    expect(out.databases.map((d) => [d.name, d.action])).toEqual([['Leads', 'created'], ['Follow-ups', 'created'], ['Stage Guide', 'created']]);
    expect(out.views).toHaveLength(3);
    expect(out.automations[0]!.name.endsWith('Notify on lead stage change')).toBe(true);
    expect(out.automations).toHaveLength(1);
    expect(out.automations[0]).toMatchObject({ action: 'created', enabled: true });
    expect(out.agents.map((a) => [a.name, a.action])).toEqual([[AGENT, 'created']]);
    const names = (await dbsOf(ws)).map((d) => d.name);
    for (const n of ['Leads', 'Follow-ups', 'Stage Guide']) expect(names.filter((x) => x === n), n).toHaveLength(1);
  });

  for (const [db, fields] of Object.entries(SPEC_FIELDS)) {
    it(`${db}: every field the spec lists exists, with its type`, async () => {
      const d = await detail(ws, db);
      const got = Object.fromEntries(d.fields.map((f) => [f.displayName, f.type]));
      for (const [name, type] of Object.entries(fields)) expect(got[name], `${db}.${name}`).toBe(type);
    });
  }

  it('Stage, Status and the selects carry the spec\'s labels (and Stage At Draft / Stage Guide Stage are the SAME eight)', async () => {
    const leads = await detail(ws, 'Leads');
    const stage = leads.fields.find((f) => f.displayName === 'Stage')!;
    expect(stage.options!.map((o) => [o.label, o.category])).toEqual([
      ['New', 'backlog'], ['Contacted', 'unstarted'], ['Call Booked', 'started'], ['Proposal Sent', 'started'], ['Negotiating', 'started'],
      ['Won', 'completed'], ['Lost', 'canceled'], ['Not now', 'canceled'],
    ]);
    const labels = (d: Detail, f: string) => d.fields.find((x) => x.displayName === f)!.options!.map((o) => o.label);
    expect(labels(leads, 'Source')).toEqual(['Referral', 'Inbound', 'Outbound', 'Event', 'Partner']);
    expect(labels(leads, 'Preferred Channel')).toEqual(['Email', 'WhatsApp', 'Phone']);
    expect(labels(leads, 'Interest')).toEqual(['Brand identity', 'Website', 'Packaging', 'Illustration', 'Other']);
    expect(labels(leads, 'Lost Reason')).toEqual(['Budget', 'Timing', 'Competitor', 'Ghosted', 'Bad fit']);
    const fu = await detail(ws, 'Follow-ups');
    expect(labels(fu, 'Stage At Draft')).toEqual(STAGES);
    expect(labels(fu, 'Channel')).toEqual(['Email', 'WhatsApp']);
    expect(fu.fields.find((f) => f.displayName === 'Status')!.options!.map((o) => [o.label, o.category])).toEqual([
      ['Drafted', 'backlog'], ['Ready for review', 'unstarted'], ['Approved', 'started'], ['Sent', 'completed'], ['Skipped', 'canceled'],
    ]);
    expect(labels(await detail(ws, 'Stage Guide'), 'Stage')).toEqual(STAGES);
    // the formula is declared after the date it reads
    const order = leads.fields.map((f) => f.displayName);
    expect(order.indexOf('Days Since Contact')).toBeGreaterThan(order.indexOf('Last Contact'));
  });

  it('Follow-ups link to Leads, with both ends named as the spec says', async () => {
    expect((await detail(ws, 'Follow-ups')).fields.map((f) => f.displayName)).toContain('Lead');
    expect((await detail(ws, 'Leads')).fields.map((f) => f.displayName)).toContain('Follow-ups');
  });

  it('views: Lead Pipeline is a board on Stage, Ready for Review is oldest-first on Ready for review, Going Quiet is silence on an open lead', async () => {
    const leads = await detail(ws, 'Leads');
    const board = leads.views.find((v) => v.name === 'Lead Pipeline')!;
    expect(board).toMatchObject({ type: 'board', isDefault: true });
    expect(board.config.group_by_field_id).toBe(leads.fields.find((f) => f.displayName === 'Stage')!.id);
    const fu = await detail(ws, 'Follow-ups');
    const review = fu.views.find((v) => v.name === 'Ready for Review')!;
    expect(review.type).toBe('table');
    expect(review.config.filters).toEqual({ field: 'status', op: 'has', value: [optId(fu, 'Status', 'Ready for review')] });
    expect(review.config.sorts).toEqual([{ field: 'created_at', direction: 'asc' }]);
    const quiet = leads.views.find((v) => v.name === 'Going Quiet')!;
    expect(quiet.config.filters).toEqual({
      and: [{ field: 'last_contact', op: 'before', value: '$date:-7d' }, { field: 'stage', op: 'category_is_not', value: ['completed', 'canceled'] }],
    });
  });

  it('sample data: 7 leads in the stages the spec names, 3 follow-ups that show the loop, 8 guide records with Wait Days 4 and 5', async () => {
    const leads = await detail(ws, 'Leads');
    const lr = await rows(ws, leads.id);
    expect(lr).toHaveLength(7);
    const stageOf = (r: Row) => leads.fields.find((f) => f.displayName === 'Stage')!.options!.find((o) => o.id === r.values.stage)!.label;
    const by = Object.fromEntries(lr.map((r) => [r.title.split(', ')[1]!.replace(' (sample)', ''), r]));
    expect(Object.fromEntries(Object.entries(by).map(([k, r]) => [k, stageOf(r)]))).toEqual({
      'Northfield Ceramics': 'New', 'Harbour Yoga': 'Contacted', 'Olive & Thyme Deli': 'Call Booked', 'Brightwater Dental': 'Proposal Sent',
      'Pine Street Books': 'Won', 'Ridgeway Cycles': 'Lost', 'Tallow Candle Co.': 'Not now',
    });
    const harbour = by['Harbour Yoga']!.values;
    expect(harbour.whatsapp_consent).toBe(true);
    expect(harbour.consent_note).toBe('Asked us to use WhatsApp on the intro call');
    expect(harbour.preferred_channel).toBe(optId(leads, 'Preferred Channel', 'WhatsApp'));
    expect(by['Brightwater Dental']!.values.deal_value).toBe(4800);
    expect(by['Ridgeway Cycles']!.values.lost_reason).toBe(optId(leads, 'Lost Reason', 'Timing'));
    expect(by['Tallow Candle Co.']!.values.next_step_date).toBe(dayStr(30));
    expect(lr.every((r) => r.values.do_not_contact !== true)).toBe(true);
    for (const r of lr) expect(r.title).toContain('(sample)');

    const fu = await detail(ws, 'Follow-ups');
    const fr = await rows(ws, fu.id);
    const status = (r: Row) => fu.fields.find((f) => f.displayName === 'Status')!.options!.find((o) => o.id === r.values.status)!.label;
    expect(Object.fromEntries(fr.map((r) => [r.title, status(r)]))).toEqual({
      'New: first reply (sample)': 'Ready for review', 'Call Booked: confirmation (sample)': 'Approved', 'Won: thank you (sample)': 'Sent',
    });
    expect(fr.every((r) => Array.isArray(r.values.lead) && (r.values.lead as unknown[]).length === 1)).toBe(true);
    expect(fr.every((r) => Array.isArray(r.values.draft) && (r.values.draft as unknown[]).length > 0)).toBe(true);

    const sg = await detail(ws, 'Stage Guide');
    const gr = await rows(ws, sg.id);
    expect(gr.map((r) => r.title).sort()).toEqual([...STAGES].sort());
    const wait = Object.fromEntries(gr.filter((r) => r.values.wait_days != null).map((r) => [r.title, r.values.wait_days]));
    expect(wait).toEqual({ Contacted: 4, 'Proposal Sent': 5 });
    for (const r of gr) expect(JSON.stringify(r.values.never_say)).toContain('No discounts, no deadlines, no \\"just circling back\\"');
  });

  it('"Days Since Contact" computes on the sample leads, and Going Quiet returns exactly the quiet open ones, longest first', async () => {
    const leads = await detail(ws, 'Leads');
    const dsc = leads.fields.find((f) => f.displayName === 'Days Since Contact')!;
    const lr = await rows(ws, leads.id);
    const days = Object.fromEntries(lr.map((r) => [r.title.split(', ')[1]!.replace(' (sample)', ''), r.values[dsc.apiName] ?? null]));
    expect(days).toEqual({
      'Northfield Ceramics': null, 'Harbour Yoga': 9, 'Olive & Thyme Deli': 2, 'Brightwater Dental': 8, 'Pine Street Books': 3, 'Ridgeway Cycles': 40, 'Tallow Candle Co.': 30,
    });
    const quiet = leads.views.find((v) => v.name === 'Going Quiet')!;
    const got = await rows(ws, leads.id, { filter: quiet.config.filters, sorts: quiet.config.sorts, limit: 200 });
    // Won (Pine Street), Lost (Ridgeway) and Not now (Tallow) are closed; Olive is only 2 days quiet; Northfield was never contacted
    expect(got.map((r) => r.title)).toEqual(['Leo Hartmann, Harbour Yoga (sample)', 'Dr Kwame Osei, Brightwater Dental (sample)']);
  });

  it('Going Quiet KEEPS a lead that crosses the line later, and drops one that is contacted again', async () => {
    const leads = await detail(ws, 'Leads');
    const quiet = leads.views.find((v) => v.name === 'Going Quiet')!;
    const q = async () => (await rows(ws, leads.id, { filter: quiet.config.filters, sorts: quiet.config.sorts, limit: 200 })).map((r) => r.title);
    const olive = (await rows(ws, leads.id)).find((r) => r.title.includes('Olive'))!;
    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${olive.id}`, { values: { last_contact: dayStr(-8) } });
    expect(await q()).toContain('Marta Kowal, Olive & Thyme Deli (sample)');
    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${olive.id}`, { values: { last_contact: dayStr(-7) } });
    expect(await q(), 'exactly 7 days is not "more than a week"').not.toContain('Marta Kowal, Olive & Thyme Deli (sample)');
    const harbour = (await rows(ws, leads.id)).find((r) => r.title.includes('Harbour'))!;
    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${harbour.id}`, { values: { last_contact: dayStr(0) } });
    expect(await q()).not.toContain('Leo Hartmann, Harbour Yoga (sample)');
  });

  it('Ready for Review holds exactly the follow-ups marked Ready for review, oldest first', async () => {
    const fu = await detail(ws, 'Follow-ups');
    const review = fu.views.find((v) => v.name === 'Ready for Review')!;
    const ready = optId(fu, 'Status', 'Ready for review');
    const lead = (await rows(ws, (await detail(ws, 'Leads')).id))[0]!;
    const mk = async (name: string, st: string) => {
      const r = await as('POST', `/workspaces/${ws}/databases/${fu.id}/records`, { values: { name, status: optId(fu, 'Status', st), lead: [lead.id] } });
      expect(r.statusCode, r.body).toBe(201);
      await new Promise((res) => setTimeout(res, 15));
    };
    await mk('Second in the queue', 'Ready for review');
    await mk('A draft nobody asked to review', 'Drafted');
    await mk('Third in the queue', 'Ready for review');
    const got = await rows(ws, fu.id, { filter: review.config.filters, sorts: review.config.sorts, limit: 200 });
    expect(got.map((r) => r.title)).toEqual(['New: first reply (sample)', 'Second in the queue', 'Third in the queue']);
    expect(got.every((r) => r.values.status === ready)).toBe(true);
  });

  it('the agent is installed SWITCHED OFF: all eight stage wakes are off, and nothing wakes until a person turns one on', async () => {
    expect(out.triggers).toHaveLength(8);
    for (const t of out.triggers) {
      expect(t.action, t.name).toBe('created');
      expect(t.enabled, t.name).toBe(false);
      expect(t.switched_off_because, t.name).toBe('wakes_agent');
      expect(t.human_gate, t.name).not.toBe(true);
    }
    const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
    const bindings = (await as('GET', `/workspaces/${ws}/databases/${ensured.triggersDb.id}/records?limit=200`)).json().data as Row[];
    expect(bindings).toHaveLength(8);
    expect(bindings.every((b) => b.values['enabled'] !== true)).toBe(true);
    const { rows: wakes } = await pool.query(
      `select count(*)::int as n from agent_wakes w join records r on r.id = w.agent_id where w.workspace_id = $1 and r.title = $2`,
      [ws, AGENT],
    );
    expect(wakes[0].n, 'the 7 sample leads woke nothing').toBe(0);
    const agents = (await as('GET', `/workspaces/${ws}/databases/${ensured.agentsDb.id}/records?limit=200`)).json().data as Row[];
    expect(agents.map((a) => a.title)).toContain(AGENT);
  });

  it('"Remove sample data" takes the 10 sample records and leaves the Stage Guide the drafter reads', async () => {
    const ws2 = await newWs('Remove');
    expect((await install(ws2)).statusCode).toBe(201);
    const removed = await as('DELETE', `/workspaces/${ws2}/templates/sample-data`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().removed).toBe(10);
    expect(await rows(ws2, (await detail(ws2, 'Leads')).id)).toHaveLength(0);
    expect(await rows(ws2, (await detail(ws2, 'Follow-ups')).id)).toHaveLength(0);
    expect((await rows(ws2, (await detail(ws2, 'Stage Guide')).id)).map((r) => r.title).sort()).toEqual([...STAGES].sort());
    expect((await as('DELETE', `/workspaces/${ws2}/templates/sample-data`)).json().removed).toBe(0);
  });

  it('a re-install is idempotent (#1157): the same databases, views, rule, agent and triggers; no second copy of anything; the sample data is not doubled', async () => {
    const ws3 = await newWs('Reinstall');
    expect((await install(ws3)).statusCode).toBe(201);
    const snapshot = async () => {
      const dbs = await dbsOf(ws3);
      const leads = await detail(ws3, 'Leads');
      const fu = await detail(ws3, 'Follow-ups');
      const sg = await detail(ws3, 'Stage Guide');
      const ensured = (await as('POST', `/workspaces/${ws3}/agents/ensure`)).json();
      const bindings = (await as('GET', `/workspaces/${ws3}/databases/${ensured.triggersDb.id}/records?limit=200`)).json().data as Row[];
      const agents = (await as('GET', `/workspaces/${ws3}/databases/${ensured.agentsDb.id}/records?limit=200`)).json().data as Row[];
      const rules = (await as('GET', `/workspaces/${ws3}/databases/${leads.id}/automations`)).json().data as Array<{ name: string }>;
      return {
        dbIds: dbs.map((d) => d.id).sort(),
        leadFields: leads.fields.length,
        views: [leads.views.length, fu.views.length, sg.views.length],
        counts: [(await rows(ws3, leads.id)).length, (await rows(ws3, fu.id)).length, (await rows(ws3, sg.id)).length],
        bindings: bindings.length,
        agents: agents.filter((a) => a.title === AGENT).length,
        rules: rules.length,
      };
    };
    const first = await snapshot();
    expect(first.counts).toEqual([7, 3, 8]);
    const again = await install(ws3);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().databases.map((d: { action: string }) => d.action)).toEqual(['reused', 'reused', 'reused']);
    expect(await snapshot()).toEqual(first);
  }, 120_000);
});

describe('#1324 the automation and the agent triggers DO their job', () => {
  it('moving a lead to another stage notifies its owner, once, and a change to something else does not', async () => {
    const ws = await newWs('Notify');
    expect((await install(ws)).statusCode).toBe(201);
    const member = await joinAs(app, owner.token, ws, 'Lead Owner Member', 'member');
    const leads = await detail(ws, 'Leads');
    const engine = app.get(AutomationsService);
    const MSG = 'Lead moved stage: Dana Quill, Test Studio. Run the drafter, or review its draft.';
    const told = async () => ((await as('GET', `/workspaces/${ws}/notifications`, undefined, member.token)).json().data ?? []).filter((n: { snippet?: string }) => n.snippet === MSG).length as number;
    const mk = await as('POST', `/workspaces/${ws}/databases/${leads.id}/records`, {
      values: { name: 'Dana Quill, Test Studio', stage: optId(leads, 'Stage', 'New'), owner: member.id },
    });
    expect(mk.statusCode, mk.body).toBe(201);
    const id = mk.json().id as string;
    await engine.settle(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(await told(), 'a new lead is not a stage CHANGE').toBe(0);

    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${id}`, { values: { notes: [{ type: 'paragraph', content: [{ type: 'text', text: 'spoke', styles: {} }] }] } });
    await engine.settle(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(await told(), 'editing Notes is not a stage change').toBe(0);

    expect((await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${id}`, { values: { stage: optId(leads, 'Stage', 'Contacted') } })).statusCode).toBe(200);
    await engine.settle(id);
    for (let i = 0; i < 40 && (await told()) < 1; i++) await new Promise((r) => setTimeout(r, 250));
    expect(await told(), 'the owner was told').toBe(1);
    const rule = ((await as('GET', `/workspaces/${ws}/databases/${leads.id}/automations`)).json().data as Array<{ id: string; name: string }>).find((r) => r.name.endsWith('Notify on lead stage change'))!;
    const runs = (await as('GET', `/workspaces/${ws}/databases/${leads.id}/automations/${rule.id}/runs`)).json().data as Array<{ status: string }>;
    expect(runs.filter((r) => r.status === 'ok'), 'one run for the one stage change').toHaveLength(1);
  }, 120_000);

  it('switched on, each of the eight stages wakes the drafter when a lead ENTERS it (created there, or moved there)', async () => {
    const ws = await newWs('Wakes');
    const subscriber = app.get(AgentTriggerSubscriber);
    const res = await install(ws, { enable_agent_triggers: STAGES.map(triggerLabel) });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().triggers as Array<{ enabled?: boolean }>).every((t) => t.enabled === true)).toBe(true);
    const leads = await detail(ws, 'Leads');
    const settleAll = async () => { for (const r of await rows(ws, leads.id)) await subscriber.settle(r.id); };
    const wakes = async () => {
      await settleAll();
      const { rows: w } = await pool.query(
        `select count(*)::int as n from agent_wakes w join records r on r.id = w.agent_id where w.workspace_id = $1 and r.title = $2`,
        [ws, AGENT],
      );
      return w[0].n as number;
    };
    // the 7 sample leads sit in 7 of the 8 stages: each woke it once on install
    expect(await wakes()).toBe(7);
    let n = 7;
    for (const stage of STAGES) {
      const r = await as('POST', `/workspaces/${ws}/databases/${leads.id}/records`, { values: { name: `Created in ${stage}`, stage: optId(leads, 'Stage', stage) } });
      expect(r.statusCode, r.body).toBe(201);
      n += 1;
      expect(await wakes(), `created in ${stage}`).toBe(n);
    }
    // a MOVE into a stage wakes it too, and a change to anything else does not
    // (a wake is one per lead while it is pending, so the move is tried on a lead that has not woken it yet: created with its stage
    // EXPLICITLY null. Leaving Stage out would not do: a fully-categorised select takes its first state on create (ticket #1325), so
    // a lead sent without a stage lands in the first stage and enters it, which is a wake, not the "no stage, no wake" this proves.)
    const mk = await as('POST', `/workspaces/${ws}/databases/${leads.id}/records`, { values: { name: 'Created with no stage', stage: null } });
    expect(mk.statusCode, mk.body).toBe(201);
    expect(await wakes(), 'no stage, no wake').toBe(n);
    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${mk.json().id}`, { values: { company: 'Renamed Co' } });
    expect(await wakes(), 'editing Company wakes nothing').toBe(n);
    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${mk.json().id}`, { values: { stage: optId(leads, 'Stage', 'Negotiating') } });
    expect(await wakes(), 'moved to Negotiating').toBe(n + 1);
  }, 180_000);

  it('the instructions keep rule 1 (Do Not Contact) as the second line of defence, and StoryOS still holds anything the agent tries to change', () => {
    const a = entry.manifest.agents[0]!;
    // rule 1 comes before any rule about drafting
    expect(a.instructions!.indexOf('If Do Not Contact is ticked, draft nothing at all')).toBeGreaterThan(-1);
    expect(a.instructions!.indexOf('1. If Do Not Contact is ticked')).toBeLessThan(a.instructions!.indexOf('2. You draft.'));
    expect(a.write_gates!.every((g) => g.operations.includes('update'))).toBe(true);
  });
});

/**
 * ticket #1324 follow-up - "Do Not Contact" is a CODE guard, not only a sentence in the prompt. The pack's eight stage triggers carry
 * the condition "Do Not Contact is unchecked"; the dispatcher checks it against the record at wake time, and a refusal is a finished wake
 * (status canceled, `skipped`) so it is visible, never a silent drop.
 */
describe('#1324 follow-up: the Do Not Contact trigger condition', () => {
  let ws: string;
  let subscriber: AgentTriggerSubscriber;
  let leads: Detail;
  let agentId: string;
  let triggersDbId: string;
  const dnc = (v: boolean) => ({ do_not_contact: v });

  beforeAll(async () => {
    ws = await newWs('Dnc');
    subscriber = app.get(AgentTriggerSubscriber);
    const res = await install(ws, { enable_agent_triggers: STAGES.map(triggerLabel) });
    expect(res.statusCode, res.body).toBe(201);
    leads = await detail(ws, 'Leads');
    const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
    triggersDbId = ensured.triggersDb.id;
    const agents = (await as('GET', `/workspaces/${ws}/databases/${ensured.agentsDb.id}/records?limit=200`)).json().data as Row[];
    agentId = agents.find((a) => a.title === AGENT)!.id;
    for (const r of await rows(ws, leads.id)) await subscriber.settle(r.id);
  }, 180_000);

  const mkLead = async (name: string, values: Record<string, unknown> = {}) => {
    const r = await as('POST', `/workspaces/${ws}/databases/${leads.id}/records`, { values: { name, ...values } });
    expect(r.statusCode, r.body).toBe(201);
    await subscriber.settle(r.json().id);
    return r.json().id as string;
  };
  const patch = async (id: string, values: Record<string, unknown>) => {
    const r = await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${id}`, { values });
    expect(r.statusCode, r.body).toBe(200);
    await subscriber.settle(id);
  };
  /** The wakes the agent has for ONE lead: real ones, and the ones recorded as skipped. */
  const wakesFor = async (recordId: string) => {
    const { rows: w } = await pool.query(
      `select status, reasons->0->'detail'->>'skipped' as skipped from agent_wakes where workspace_id = $1 and agent_id = $2 and record_id = $3 order by created_at`,
      [ws, agentId, recordId],
    );
    const all = w as Array<{ status: string; skipped: string | null }>;
    return { woke: all.filter((r) => r.skipped === null), skipped: all.filter((r) => r.skipped !== null) };
  };

  for (const stage of STAGES) {
    it(`${stage}: a Do Not Contact lead entering it does NOT wake the drafter and the skip is recorded; an ordinary lead still does`, async () => {
      const blocked = await mkLead(`Blocked in ${stage}`, { stage: optId(leads, 'Stage', stage), ...dnc(true) });
      const b = await wakesFor(blocked);
      expect(b.woke, 'no wake for a Do Not Contact lead').toHaveLength(0);
      expect(b.skipped).toHaveLength(1);
      expect(b.skipped[0]).toMatchObject({ status: 'canceled', skipped: 'condition_not_met' });

      const ordinary = await mkLead(`Ordinary in ${stage}`, { stage: optId(leads, 'Stage', stage), ...dnc(false) });
      const o = await wakesFor(ordinary);
      expect(o.woke, 'an ordinary lead wakes it').toHaveLength(1);
      expect(o.skipped).toHaveLength(0);

      const unset = await mkLead(`Unset in ${stage}`, { stage: optId(leads, 'Stage', stage) });
      expect((await wakesFor(unset)).woke, 'a lead whose Do Not Contact was never set counts as unchecked and wakes it').toHaveLength(1);
    }, 60_000);
  }

  it('toggling Do Not Contact on an existing lead, then moving its stage, is judged on the value AT THE MOVE', async () => {
    const id = await mkLead('Toggled lead', { stage: null }); // explicitly null: a lead sent without a stage lands in the first one (ticket #1325)
    await patch(id, { ...dnc(true) });
    await patch(id, { stage: optId(leads, 'Stage', 'Contacted') });
    let w = await wakesFor(id);
    expect(w.woke).toHaveLength(0);
    expect(w.skipped).toHaveLength(1);

    await patch(id, { ...dnc(false) });
    await patch(id, { stage: optId(leads, 'Stage', 'Call Booked') });
    w = await wakesFor(id);
    expect(w.woke, 'unticked, the next move wakes it').toHaveLength(1);
    expect(w.skipped, 'and the earlier skip is still on the record').toHaveLength(1);

    // the other way round: a lead that was ordinary and is later marked Do Not Contact (its earlier wake finished, so the slot is free)
    await pool.query(`update agent_wakes set status = 'done', finished_at = now() where workspace_id = $1 and agent_id = $2 and record_id = $3 and status = 'queued'`, [ws, agentId, id]);
    await patch(id, { ...dnc(true) });
    await patch(id, { stage: optId(leads, 'Stage', 'Proposal Sent') });
    w = await wakesFor(id);
    expect(w.woke, 'ticked again, the move wakes nothing new').toHaveLength(1);
    expect(w.skipped).toHaveLength(2);
  }, 90_000);

  it('the skip is VISIBLE through the wake list: status canceled and `skipped` says which rule refused', async () => {
    const id = await mkLead('Visible skip', { stage: optId(leads, 'Stage', 'New'), ...dnc(true) });
    const res = await as('GET', `/workspaces/${ws}/agent-wakes?agent=${agentId}&record=${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const list = res.json().data as Array<{ status: string; skipped: { code: string; message: string; trigger_id: string | null } | null }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('canceled');
    expect(list[0]!.skipped?.code).toBe('condition_not_met');
    expect(list[0]!.skipped?.message).toMatch(/does not match this trigger's condition/);
    expect(list[0]!.skipped?.trigger_id).toBeTruthy();
    // and a real wake carries no skip
    const ok = await mkLead('Visible wake', { stage: optId(leads, 'Stage', 'New') });
    const okList = (await as('GET', `/workspaces/${ws}/agent-wakes?agent=${agentId}&record=${ok}`)).json().data as Array<{ skipped: unknown; status: string }>;
    expect(okList).toHaveLength(1);
    expect(okList[0]!.skipped).toBeNull();
    expect(okList[0]!.status).toBe('queued');
  }, 60_000);

  it('a skipped wake does not hold the open-wake slot: the same lead wakes the drafter the moment it is eligible', async () => {
    const id = await mkLead('Slot lead', { stage: optId(leads, 'Stage', 'New'), ...dnc(true) });
    expect((await wakesFor(id)).skipped).toHaveLength(1);
    await patch(id, { ...dnc(false), stage: optId(leads, 'Stage', 'Contacted') });
    const w = await wakesFor(id);
    expect(w.woke).toHaveLength(1);
    expect(w.woke[0]!.status).toBe('queued');
  }, 60_000);

  it('a malformed stored condition FAILS CLOSED: nothing wakes, the skip says condition_invalid, and it is logged once', async () => {
    const { rows: fieldRows } = await pool.query(`select id from fields where database_id = $1 and api_name = 'condition'`, [triggersDbId]);
    expect(fieldRows).toHaveLength(1);
    const conditionFieldId = fieldRows[0].id as string;
    const bindings = (await as('GET', `/workspaces/${ws}/databases/${triggersDbId}/records?limit=200`)).json().data as Row[];
    const target = bindings.find((b) => String(b.title).endsWith('= New'))!;
    const original = target.values['condition'];
    expect(typeof original).toBe('string');
    const setStored = (v: string) => pool.query(`update records set values = jsonb_set(values, ARRAY[$2::text], to_jsonb($3::text)) where id = $1`, [target.id, conditionFieldId, v]);
    const warn = vi.spyOn((subscriber as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    try {
      for (const broken of ['{ this is not json', '{"field":"no_such_field","op":"eq","value":false}', '{"and":[]}', '"just a string"']) {
        await setStored(broken);
        const id = await mkLead(`Broken ${broken.slice(0, 8)}`, { stage: optId(leads, 'Stage', 'New'), ...dnc(false) });
        const w = await wakesFor(id);
        expect(w.woke, `broken condition ${broken}: it must not run the agent`).toHaveLength(0);
        expect(w.skipped, broken).toHaveLength(1);
      }
      const { rows: reasons } = await pool.query(`select distinct reasons->0->'detail'->>'skipped' as s from agent_wakes where workspace_id = $1 and agent_id = $2 and status = 'canceled'`, [ws, agentId]);
      expect((reasons as Array<{ s: string }>).map((r) => r.s)).toContain('condition_invalid');
      const logged = warn.mock.calls.filter((c) => String(c[0]).includes(`agent trigger ${target.id}`) && String(c[0]).includes('failing closed'));
      expect(logged, 'one warning for the binding, however many events').toHaveLength(1);
    } finally {
      warn.mockRestore();
      await setStored(original as string);
    }
    const back = await mkLead('Healed', { stage: optId(leads, 'Stage', 'New'), ...dnc(false) });
    expect((await wakesFor(back)).woke, 'with the condition restored it wakes again').toHaveLength(1);
  }, 120_000);

  it('a trigger WITHOUT a condition is unchanged (what must be KEPT): every state change wakes, a Do Not Contact lead included', async () => {
    const bindings = (await as('GET', `/workspaces/${ws}/databases/${triggersDbId}/records?limit=200`)).json().data as Row[];
    const target = bindings.find((b) => String(b.title).endsWith('= Won'))!;
    const patched = await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${target.id}`, { values: { condition: '' } });
    expect(patched.statusCode, patched.body).toBe(200);
    const id = await mkLead('No guard on Won', { stage: optId(leads, 'Stage', 'Won'), ...dnc(true) });
    expect((await wakesFor(id)).woke, 'cleared on purpose: the trigger wakes for everyone, as triggers did before').toHaveLength(1);
  }, 60_000);

  it("a stored condition of the JSON text 'null' (or any non-filter value) is INVALID and fails closed, while an absent or empty one is no condition", async () => {
    const { rows: fieldRows } = await pool.query(`select id from fields where database_id = $1 and api_name = 'condition'`, [triggersDbId]);
    const conditionFieldId = fieldRows[0].id as string;
    const bindings = (await as('GET', `/workspaces/${ws}/databases/${triggersDbId}/records?limit=200`)).json().data as Row[];
    const target = bindings.find((b) => String(b.title).endsWith('= Contacted'))!;
    const original = target.values['condition'] as string;
    const setStored = (v: string) => pool.query(`update records set values = jsonb_set(values, ARRAY[$2::text], to_jsonb($3::text)) where id = $1`, [target.id, conditionFieldId, v]);
    try {
      for (const stored of ['null', '[]', '0', '"x"', 'true', ' null ']) {
        await setStored(stored);
        const id = await mkLead(`Stored ${stored.trim()}`, { stage: optId(leads, 'Stage', 'Contacted'), ...dnc(true) });
        const w = await wakesFor(id);
        expect(w.woke, `stored ${stored} must not run the agent`).toHaveLength(0);
        expect(w.skipped, stored).toHaveLength(1);
        expect(w.skipped[0]!.skipped, stored).toBe('condition_invalid');
      }
      // absent (the key is gone) and empty both mean no condition: the trigger is unguarded, as triggers were before
      await pool.query(`update records set values = values - $2::text where id = $1`, [target.id, conditionFieldId]);
      const absent = await mkLead('Absent condition', { stage: optId(leads, 'Stage', 'Contacted'), ...dnc(true) });
      expect((await wakesFor(absent)).woke).toHaveLength(1);
      await setStored('');
      const empty = await mkLead('Empty condition', { stage: optId(leads, 'Stage', 'Contacted'), ...dnc(true) });
      expect((await wakesFor(empty)).woke).toHaveLength(1);
    } finally {
      await setStored(original);
    }
  }, 90_000);

  it("records API: the text 'null' and other JSON that is not a filter object are refused with a 422, and clearing is still allowed", async () => {
    const bindings = (await as('GET', `/workspaces/${ws}/databases/${triggersDbId}/records?limit=200`)).json().data as Row[];
    const target = bindings.find((b) => String(b.title).endsWith('= Not now'))!;
    const before = target.values['condition'];
    for (const bad of ['null', '[]', '0', '"x"', 'true']) {
      const res = await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${target.id}`, { values: { condition: bad } });
      expect(res.statusCode, `${bad}: ${res.body}`).toBe(422);
    }
    const stored = (await as('GET', `/workspaces/${ws}/databases/${triggersDbId}/records/${target.id}`)).json();
    expect(stored.values['condition'], 'a refused edit changed nothing').toBe(before);
    const cleared = await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${target.id}`, { values: { condition: '' } });
    expect(cleared.statusCode, cleared.body).toBe(200);
  }, 60_000);

  it('records API: a condition that is not a filter, or does not compile on the bound database, is refused with a 422', async () => {
    const bindings = (await as('GET', `/workspaces/${ws}/databases/${triggersDbId}/records?limit=200`)).json().data as Row[];
    const target = bindings.find((b) => String(b.title).endsWith('= Lost'))!;
    for (const bad of ['not json at all', '{"field":"no_such_field","op":"eq","value":false}', '{"field":"do_not_contact","op":"contains","value":"x"}', '{"field":"do_not_contact","op":"eq","value":"yes"}']) {
      const res = await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${target.id}`, { values: { condition: bad } });
      expect(res.statusCode, `${bad}: ${res.body}`).toBe(422);
    }
    const stored = (await as('GET', `/workspaces/${ws}/databases/${triggersDbId}/records/${target.id}`)).json();
    expect(JSON.parse(stored.values['condition'] as string), 'a refused edit changed nothing').toEqual({ field: 'do_not_contact', op: 'eq', value: false });
    const ok = await as('PATCH', `/workspaces/${ws}/databases/${triggersDbId}/records/${target.id}`, { values: { condition: JSON.stringify({ field: 'do_not_contact', op: 'eq', value: false }) } });
    expect(ok.statusCode, ok.body).toBe(200);
  }, 60_000);

  it('POST /agents/triggers: a condition is stored and listed in the wake sources; a bad one is refused; permissions are what they were', async () => {
    const w2 = await newWs('DncApi');
    const inst = await install(w2);
    expect(inst.statusCode, inst.body).toBe(201);
    const d = await detail(w2, 'Leads');
    const ensured = (await as('POST', `/workspaces/${w2}/agents/ensure`)).json();
    const ag = ((await as('GET', `/workspaces/${w2}/databases/${ensured.agentsDb.id}/records?limit=200`)).json().data as Row[]).find((a) => a.title === AGENT)!;
    const stageField = d.fields.find((f) => f.displayName === 'Stage')!;
    const base = { agent: ag.id, database_id: d.id, state_field_id: stageField.id, state_option_id: optId(d, 'Stage', 'New') };
    const cond = { and: [{ field: 'do_not_contact', op: 'eq', value: false }, { field: 'whatsapp_consent', op: 'eq', value: true }] };

    const bad = await as('POST', `/workspaces/${w2}/agents/triggers`, { ...base, condition: { field: 'nope', op: 'eq', value: false } });
    expect(bad.statusCode, bad.body).toBe(422);
    const malformed = await as('POST', `/workspaces/${w2}/agents/triggers`, { ...base, condition: { field: 'do_not_contact', op: 'not_an_op' } });
    expect(malformed.statusCode, malformed.body).toBe(422);

    const created = await as('POST', `/workspaces/${w2}/agents/triggers`, { ...base, condition: cond, enabled: false });
    expect(created.statusCode, created.body).toBe(201);
    expect(JSON.parse(created.json().values.condition)).toEqual(cond);

    const src = (await as('GET', `/workspaces/${w2}/agents/${ag.id}/wake-sources`)).json().sources as Array<{ kind: string; id: string; condition?: unknown }>;
    const mine = src.find((s) => s.kind === 'agent_trigger' && s.id === created.json().id)!;
    expect(mine.condition).toEqual(cond);
    const pack = src.filter((s) => s.kind === 'agent_trigger' && s.id !== created.json().id);
    expect(pack, 'the pack triggers list the guard').toHaveLength(8);
    expect(pack.every((s) => JSON.stringify(s.condition) === JSON.stringify({ field: 'do_not_contact', op: 'eq', value: false }))).toBe(true);

    // permissions: a plain member could not create a trigger before and still cannot, with or without a condition
    const member = await joinAs(app, owner.token, w2, 'Dnc Member', 'member');
    const asMember = (body: unknown) => call(app, member.token, 'POST', `/workspaces/${w2}/agents/triggers`, body);
    const without = await asMember(base);
    const withCond = await asMember({ ...base, condition: cond });
    expect(withCond.statusCode, withCond.body).toBe(without.statusCode);
    expect(without.statusCode).not.toBe(201);
  }, 120_000);

  it('catch-up does not offer a Do Not Contact lead (that would wake the agent past its own guard)', async () => {
    const w3 = await newWs('DncCatchUp');
    expect((await install(w3)).statusCode).toBe(201); // triggers installed OFF: no event wakes anything
    const d = await detail(w3, 'Leads');
    const ensured = (await as('POST', `/workspaces/${w3}/agents/ensure`)).json();
    const ag = ((await as('GET', `/workspaces/${w3}/databases/${ensured.agentsDb.id}/records?limit=200`)).json().data as Row[]).find((a) => a.title === AGENT)!;
    const mk = async (name: string, v: boolean) => (await as('POST', `/workspaces/${w3}/databases/${d.id}/records`, { values: { name, stage: optId(d, 'Stage', 'Lost'), do_not_contact: v } })).json().id as string;
    const blocked = await mk('Catch-up blocked', true);
    const fine = await mk('Catch-up fine', false);
    // now switch the Lost trigger on: both leads are already in the state with no wake
    const bindings = (await as('GET', `/workspaces/${w3}/databases/${ensured.triggersDb.id}/records?limit=200`)).json().data as Row[];
    const lost = bindings.find((b) => String(b.title).endsWith('= Lost'))!;
    expect((await as('PATCH', `/workspaces/${w3}/databases/${ensured.triggersDb.id}/records/${lost.id}`, { values: { enabled: true } })).statusCode).toBe(200);
    const res = await as('GET', `/workspaces/${w3}/agents/${ag.id}/catch-up?limit=100`);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toContain(fine);
    expect(items.map((i) => i.id), 'the Do Not Contact lead is not offered').not.toContain(blocked);
    expect(res.json().total).toBe(items.length);
  }, 120_000);
});
