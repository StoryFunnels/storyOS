/**
 * #451 — the plan: what the seeder is going to create, worked out in full
 * before anything is written.
 *
 * This module is PURE. No database, no network, no clock. That separation is
 * what makes the determinism claim testable in milliseconds instead of
 * minutes: hash two plans built from the same seed and compare, rather than
 * seeding twice and diffing postgres.
 *
 * What "byte-identical" can and cannot mean here: everything this file invents
 * — names, values, timestamps, structure, link topology — is identical for a
 * given seed. Record ids and public record numbers are allocated by the server
 * and cannot be, so the determinism test asserts on the plan, and the seeder
 * prints the plan hash so two environments can be compared by eye.
 */
import { Rng, SEED_EPOCH, daysBefore } from './rng';
import {
  CLIENT_NAMES,
  DOC_PARAGRAPHS,
  PERSON_NAMES,
  PRIORITY_OPTIONS,
  PROJECT_WORDS,
  STATUS_OPTIONS,
  TAG_OPTIONS,
  TASK_OBJECTS,
  TASK_VERBS,
} from './vocab';

export type Persona = 'nadia' | 'kai';

export interface PlannedField {
  key: string;
  display_name: string;
  type: 'text' | 'rich_text' | 'number' | 'checkbox' | 'date' | 'select' | 'multi_select' | 'workflow' | 'url' | 'email' | 'user';
  options?: string[];
}

export interface PlannedEdit {
  /** Values to PATCH on a later date — this is what makes version history real. */
  values: Record<string, unknown>;
  at: string;
}

export interface PlannedRecord {
  title: string;
  values: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** Zero, one or two real subsequent edits. Some records must be edited more than once. */
  edits: PlannedEdit[];
  /** Rich-text document body, for the document-heavy persona. */
  document?: string[];
}

export interface PlannedDatabase {
  key: string;
  name: string;
  space_key: string;
  description: string;
  fields: PlannedField[];
  records: PlannedRecord[];
}

export interface PlannedRelation {
  key: string;
  a_key: string;
  b_key: string;
  cardinality: 'one_to_many' | 'many_to_many';
  field_a_name: string;
  field_b_name: string;
  /** Index-into-records pairs, so links are as deterministic as the records. */
  links: Array<{ from: number; to: number }>;
}

export interface PlannedSpace {
  key: string;
  name: string;
}

export interface PlannedWorkspace {
  /** Stable identity across runs. The seeder matches on this to stay additive. */
  key: string;
  name: string;
  size: 'large' | 'medium' | 'tiny';
  spaces: PlannedSpace[];
  databases: PlannedDatabase[];
  relations: PlannedRelation[];
  /** #451 — only guests can hold partial access, so the guest gets ONE space of several. */
  guest_grant?: { space_key: string; role: 'commenter' | 'editor' };
}

export interface SeedPlan {
  persona: Persona;
  seed: string;
  owner: { email: string; name: string };
  guest: { email: string; name: string } | null;
  workspaces: PlannedWorkspace[];
  totals: { workspaces: number; databases: number; records: number };
}

/** Six months, the window the ticket asks for. */
const HISTORY_DAYS = 183;

export interface PlanOptions {
  /**
   * Multiplies every record count. 1 is the real environment; the integration
   * test uses a small fraction so it can seed twice in seconds. It never
   * changes the SHAPE — same workspaces, same databases, same relations — so a
   * scaled run still exercises every structural case.
   */
  scale?: number;
}

const STATUS_FIELD: PlannedField = {
  key: 'status',
  display_name: 'Status',
  type: 'workflow',
  // #451 — deliberately more options than fit comfortably on a board.
  options: [...STATUS_OPTIONS],
};

function commonFields(): PlannedField[] {
  return [
    STATUS_FIELD,
    { key: 'priority', display_name: 'Priority', type: 'select', options: [...PRIORITY_OPTIONS] },
    { key: 'tags', display_name: 'Tags', type: 'multi_select', options: [...TAG_OPTIONS] },
    { key: 'owner', display_name: 'Owner', type: 'text' },
    { key: 'estimate', display_name: 'Estimate (h)', type: 'number' },
    { key: 'due', display_name: 'Due', type: 'date' },
    { key: 'billable', display_name: 'Billable', type: 'checkbox' },
    { key: 'brief', display_name: 'Brief', type: 'rich_text' },
  ];
}

function docFields(): PlannedField[] {
  return [
    STATUS_FIELD,
    { key: 'tags', display_name: 'Tags', type: 'multi_select', options: [...TAG_OPTIONS] },
    { key: 'source', display_name: 'Source', type: 'url' },
    { key: 'body', display_name: 'Body', type: 'rich_text' },
    { key: 'wordcount', display_name: 'Word count', type: 'number' },
  ];
}

/**
 * One record. `messy` is the Kai flavour: half-filled rows, untitled rows,
 * rows with a single field set — the states a fast solo user actually leaves
 * behind, and the ones a tidy fixture never reproduces.
 */
function makeRecord(rng: Rng, fields: PlannedField[], title: string, messy: boolean): PlannedRecord {
  const created = daysBefore(rng, HISTORY_DAYS);
  const values: Record<string, unknown> = {};
  // A messy record fills a random handful; a tidy one fills nearly everything.
  const fillCount = messy ? rng.int(1, Math.max(2, fields.length - 2)) : rng.int(fields.length - 2, fields.length + 1);
  for (const field of rng.sample(fields, fillCount)) {
    values[field.key] = valueFor(rng, field);
  }
  /*
   * #451 — "some records have been edited more than once".
   *
   * Every edit is one real PATCH, and the API rate-limits at 300/minute, so
   * the edit rate is what decides whether the seeder fits the five-minute
   * budget the ticket sets. A third of 2,400 records is roughly 1,100 extra
   * requests and blows it; this rate produces a few hundred edits, of which
   * ~60 records are edited twice — enough for version history to have depth to
   * page through, which is the property that actually needed data.
   */
  const edits: PlannedEdit[] = [];
  const editCount = rng.chance(0.025) ? 2 : rng.chance(0.06) ? 1 : 0;
  let last = created;
  for (let i = 0; i < editCount; i++) {
    const gapDays = rng.int(1, 30);
    // Clamped to the seeder's fixed epoch, never to the wall clock — an edit
    // date that depends on when you ran it is not reproducible.
    const at = new Date(Math.min(last.getTime() + gapDays * 86_400_000, SEED_EPOCH.getTime()));
    last = at;
    const field = rng.pick(fields);
    edits.push({ values: { [field.key]: valueFor(rng, field) }, at: at.toISOString() });
  }
  return {
    title: messy && rng.chance(0.12) ? '' : title,
    values,
    created_at: created.toISOString(),
    updated_at: last.toISOString(),
    edits,
  };
}

function valueFor(rng: Rng, field: PlannedField): unknown {
  switch (field.type) {
    case 'select':
    case 'workflow':
      return rng.pick(field.options ?? ['—']);
    case 'multi_select':
      return rng.sample(field.options ?? [], rng.int(0, 3));
    case 'number':
      return rng.int(1, 80);
    case 'checkbox':
      return rng.chance(0.4);
    case 'date':
      return daysBefore(rng, HISTORY_DAYS).toISOString();
    case 'url':
      return `https://example.invalid/${rng.int(1000, 9999)}`;
    case 'email':
      return `${rng.pick(PERSON_NAMES).split(' ')[0]!.toLowerCase()}@example.invalid`;
    case 'rich_text':
      return rng.sample(DOC_PARAGRAPHS, rng.int(1, 4));
    case 'text':
    default:
      return rng.pick(PERSON_NAMES);
  }
}

function taskTitle(rng: Rng): string {
  return `${rng.pick(TASK_VERBS)} ${rng.pick(TASK_OBJECTS)}`;
}

function makeDatabase(
  rng: Rng,
  opts: { key: string; name: string; spaceKey: string; description: string; count: number; fields: PlannedField[]; messy: boolean; titler?: (r: Rng) => string },
): PlannedDatabase {
  const titler = opts.titler ?? taskTitle;
  const records: PlannedRecord[] = [];
  for (let i = 0; i < opts.count; i++) {
    records.push(makeRecord(rng.fork(`${opts.key}:rec:${i}`), opts.fields, titler(rng), opts.messy));
  }
  return {
    key: opts.key,
    name: opts.name,
    space_key: opts.spaceKey,
    description: opts.description,
    fields: opts.fields,
    records,
  };
}

/**
 * Deterministic link pairs between two record sets.
 *
 * `oneTargetPerSource` exists because a one-to-many A-side record may hold
 * exactly one link — the API rejects a second with a 409 telling you to use
 * replace. Planning two and letting the write fail meant a whole workspace's
 * links were quietly missing while the seeder reported success.
 */
function linkPairs(
  rng: Rng,
  fromCount: number,
  toCount: number,
  howMany: number,
  oneTargetPerSource = false,
): Array<{ from: number; to: number }> {
  const pairs: Array<{ from: number; to: number }> = [];
  if (fromCount === 0 || toCount === 0) return pairs;
  const seen = new Set<string>();
  const usedSources = new Set<number>();
  for (let i = 0; i < howMany; i++) {
    const from = rng.int(0, fromCount);
    const to = rng.int(0, toCount);
    // A self-relation must never link a record to itself — that is a cycle the
    // product allows but nobody means, and it makes the diagram unreadable.
    if (fromCount === toCount && from === to) continue;
    if (oneTargetPerSource && usedSources.has(from)) continue;
    const k = `${from}:${to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    usedSources.add(from);
    pairs.push({ from, to });
  }
  return pairs;
}

function scaled(n: number, scale: number): number {
  return Math.max(n > 0 ? 1 : 0, Math.round(n * scale));
}

/** Nadia: the big, uneven, aged agency environment. */
function planNadia(seed: string, scale: number): PlannedWorkspace[] {
  const root = new Rng(`nadia:${seed}`);
  const clients = root.sample(CLIENT_NAMES, 11);
  // Deliberately uneven: uniform fixtures hide exactly the pagination and
  // layout bugs these environments exist to find.
  const shape: Array<{ size: 'large' | 'medium' | 'tiny'; dbs: number[] }> = [
    { size: 'large', dbs: [560, 240, 180, 120, 90] },
    { size: 'large', dbs: [420, 210, 150, 80] },
    { size: 'medium', dbs: [60] },
    { size: 'medium', dbs: [55] },
    { size: 'medium', dbs: [45] },
    { size: 'medium', dbs: [70] },
    { size: 'medium', dbs: [50] },
    { size: 'medium', dbs: [40] },
    { size: 'tiny', dbs: [4] },
    { size: 'tiny', dbs: [6] },
    { size: 'tiny', dbs: [3] },
  ];

  return shape.map((entry, wsIndex) => {
    const client = clients[wsIndex]!;
    const key = `nadia-${seed}-ws${wsIndex + 1}`;
    const rng = root.fork(key);
    // The first large workspace carries the shapes that break things: a second
    // space (for a cross-space relation), a self-relation, and the guest.
    const isFlagship = wsIndex === 0;
    const spaces: PlannedSpace[] = isFlagship ? [{ key: 'delivery', name: 'Delivery' }] : [];

    const databases = entry.dbs.map((count, dbIndex) => {
      const dbKey = `${key}-db${dbIndex + 1}`;
      // Only the flagship's second database lives in the extra space, so the
      // relation below genuinely crosses one.
      const spaceKey = isFlagship && dbIndex === 1 ? 'delivery' : 'general';
      return makeDatabase(rng.fork(dbKey), {
        key: dbKey,
        name: `${rng.pick(PROJECT_WORDS)} ${dbIndex === 0 ? 'Tasks' : dbIndex === 1 ? 'Deliverables' : `Board ${dbIndex}`}`,
        spaceKey,
        description: `Synthetic ${entry.size} dataset for ${client}.`,
        count: scaled(count, scale),
        fields: commonFields(),
        messy: false,
      });
    });

    const relations: PlannedRelation[] = [];
    if (isFlagship && databases.length >= 2) {
      const tasks = databases[0]!;
      const deliverables = databases[1]!;
      // Cross-space: Tasks (General) ↔ Deliverables (Delivery).
      relations.push({
        key: `${key}-rel-cross`,
        a_key: tasks.key,
        b_key: deliverables.key,
        cardinality: 'many_to_many',
        field_a_name: 'Deliverables',
        field_b_name: 'Tasks',
        links: linkPairs(rng.fork(`${key}:cross`), tasks.records.length, deliverables.records.length, scaled(300, scale)),
      });
      // Self-relation on Tasks — the other shape that breaks diagrams.
      relations.push({
        key: `${key}-rel-self`,
        a_key: tasks.key,
        b_key: tasks.key,
        cardinality: 'many_to_many',
        field_a_name: 'Blocks',
        field_b_name: 'Blocked by',
        links: linkPairs(rng.fork(`${key}:self`), tasks.records.length, tasks.records.length, scaled(120, scale)),
      });
    } else if (databases.length >= 2) {
      const [a, b] = [databases[0]!, databases[1]!];
      relations.push({
        key: `${key}-rel`,
        a_key: a.key,
        b_key: b.key,
        cardinality: 'one_to_many',
        field_a_name: 'Deliverables',
        field_b_name: 'Task',
        links: linkPairs(rng.fork(`${key}:rel`), a.records.length, b.records.length, scaled(100, scale), true),
      });
    }

    return {
      key,
      name: client,
      size: entry.size,
      spaces,
      databases,
      relations,
      guest_grant: isFlagship ? { space_key: 'delivery', role: 'commenter' } : undefined,
    };
  });
}

/** Kai: one workspace, document-heavy, deliberately messy. */
function planKai(seed: string, scale: number): PlannedWorkspace[] {
  const root = new Rng(`kai:${seed}`);
  const key = `kai-${seed}-ws1`;
  const rng = root.fork(key);
  const sizes: Array<{ name: string; count: number }> = [
    { name: 'Notes', count: 500 },
    { name: 'Clips', count: 250 },
    { name: 'Inbox', count: 150 },
  ];
  const databases = sizes.map((s, i) => {
    const db = makeDatabase(rng.fork(`${key}-db${i + 1}`), {
      key: `${key}-db${i + 1}`,
      name: s.name,
      spaceKey: 'general',
      description: 'Synthetic solo-operator dataset — deliberately half-filled.',
      count: scaled(s.count, scale),
      fields: docFields(),
      messy: true,
      titler: (r) => `${r.pick(PROJECT_WORDS)} — ${r.pick(TASK_OBJECTS)}`,
    });
    // The document body is the point of this persona: long pasted content, not structure.
    const docRng = rng.fork(`${key}-db${i + 1}:docs`);
    for (const record of db.records) {
      if (docRng.chance(0.6)) record.document = docRng.sample(DOC_PARAGRAPHS, docRng.int(2, 7));
    }
    return db;
  });
  return [
    {
      key,
      name: 'Solo Studio (synthetic)',
      size: 'large',
      spaces: [],
      databases,
      relations: [],
    },
  ];
}

export function buildPlan(persona: Persona, seed: string, options: PlanOptions = {}): SeedPlan {
  const scale = options.scale ?? 1;
  const workspaces = persona === 'nadia' ? planNadia(seed, scale) : planKai(seed, scale);
  const databases = workspaces.reduce((n, w) => n + w.databases.length, 0);
  const records = workspaces.reduce(
    (n, w) => n + w.databases.reduce((m, d) => m + d.records.length, 0),
    0,
  );
  return {
    persona,
    seed,
    // Fixed, obviously synthetic, and derived from the seed so two seeds do not
    // fight over one account.
    owner: { email: `${persona}-${seed}@agents.storyos.invalid`, name: persona === 'nadia' ? 'Nadia (agent)' : 'Kai (agent)' },
    guest:
      persona === 'nadia'
        ? { email: `guest-${seed}@agents.storyos.invalid`, name: 'Tuva Synthetic (guest)' }
        : null,
    workspaces,
    totals: { workspaces: workspaces.length, databases, records },
  };
}
