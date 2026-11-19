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
      'never change the lead\'s Stage', 'WhatsApp only when WhatsApp Consent is ticked', 'never a group', 'say why in Reviewer Note', 'Never invent a price',
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
    const mover = (await rows(ws, leads.id)).find((r) => r.title === 'Created in New')!;
    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${mover.id}`, { values: { company: 'Renamed Co' } });
    expect(await wakes(), 'editing Company wakes nothing').toBe(n);
    await as('PATCH', `/workspaces/${ws}/databases/${leads.id}/records/${mover.id}`, { values: { stage: optId(leads, 'Stage', 'Negotiating') } });
    expect(await wakes(), 'moved to Negotiating').toBe(n + 1);
  }, 180_000);

  it('a Do Not Contact lead still wakes the drafter (a trigger cannot filter): the refusal is the instructions\' first rule, and StoryOS holds anything the agent tries to change', () => {
    const a = entry.manifest.agents[0]!;
    // rule 1 comes before any rule about drafting
    expect(a.instructions!.indexOf('If Do Not Contact is ticked, draft nothing at all')).toBeGreaterThan(-1);
    expect(a.instructions!.indexOf('1. If Do Not Contact is ticked')).toBeLessThan(a.instructions!.indexOf('2. You draft.'));
    expect(a.write_gates!.every((g) => g.operations.includes('update'))).toBe(true);
  });
});
