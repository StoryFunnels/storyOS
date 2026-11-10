/**
 * #978 — the install dialog's ONE list, in a person's words.
 *
 * The preview API labels a view "Tickets.Board" and an automation "Tickets.Notify on status change"; those are
 * lookup keys, not names. A row says "Board" with "view of Tickets" under it. The key survives as `key` because the
 * install's `resolutions` are keyed by it.
 *
 * Pure so every sentence is tested: a row's note comes from `itemEffect` (the preview's own action + `gains`), never
 * a hope, and a NEW item carries no note (the dialog says "All new" once).
 */

import type { PackDatabaseGains, PackAgentUpdate } from '@storyos/schemas';
import type { SwitchedOffBecause } from './pack-automation-state';
import { itemEffect, type PackItemKind } from './pack-update';

export interface PreviewRowItem {
  name: string;
  action: 'create' | 'reuse' | 'collision';
  agent_update?: PackAgentUpdate;
  gains?: PackDatabaseGains;
  /** Ticket #1172 — automations only, and only when the install would CREATE the rule: see lib/pack-automation-state.ts. */
  enabled_on_install?: boolean;
  switched_off_because?: SwitchedOffBecause;
}

/** The slice of the manifest the rows read; everything optional, because a manifest arrives as `unknown`. */
export interface RowManifest {
  databases?: Array<{
    name: string;
    space?: string;
    fields?: Array<{ name: string; options?: Array<{ label: string }> }>;
  }>;
  /** Workflow state fields live apart from `databases[].fields` (planStateSchema). */
  states?: Array<{ database: string; field: string; options?: Array<{ label: string }> }>;
  /** `from_field` is created on the `from` database; that database owns the name. */
  relations?: Array<{ from: string; to?: string; from_field: string; to_field?: string }>;
  views?: Array<{ database: string; name: string; type?: string; default?: boolean }>;
  automations?: Array<{ database: string; name: string }>;
  agents?: Array<{ name: string; goal?: string; approval_policy?: string[] }>;
  sample_records?: unknown[];
}

export interface InstallRow {
  /** The preview API's label — what `resolutions` are keyed by. */
  key: string;
  kind: PackItemKind;
  /** For a view row: its type (`board`, `table`…), so the row can draw the right glyph. */
  viewType?: string;
  /** What the row is called to a person: "Board", not "Tickets.Board". */
  name: string;
  /** Muted line under the name: "view of Tickets". */
  sub: string;
  /** A database's relations on their OWN line, "Links to Project, Sprint"; null for everything else and for a database with none. */
  links: string | null;
  action: PreviewRowItem['action'];
  /** Present only when something is NOT new. Null for a new item and for an agent, whose note is `agentEffect`. */
  note: string | null;
  item: PreviewRowItem;
}

const GATE_WORDS: Record<string, string> = {
  delete: 'deleting',
  webhook: 'calling a webhook',
  email: 'sending email',
  run_button: 'pressing a button',
  outward: 'anything that leaves your workspace',
};

/** "asks before deleting and sending email"; null when the agent declares no gates (it then says nothing it cannot back). */
export function approvalSentence(policy: string[] | undefined): string | null {
  const words = (policy ?? []).map((p) => GATE_WORDS[p] ?? p);
  if (words.length === 0) return null;
  const list =
    words.length === 1
      ? words[0]!
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `It asks before ${list}.`;
}

/** The first sentence of a goal, trimmed — the row shows what the agent does, not its whole brief. */
function firstSentence(goal: string | undefined): string {
  const g = (goal ?? '').trim();
  const m = /^[^.!?]*[.!?](?=\s|$)/.exec(g);
  return (m ? m[0] : g).replace(/[.!?]$/, '');
}

/** How many field names a database row lists before it says "+N more". */
export const ROW_FIELDS_MAX = 6;

/** "Status, Assignee, Due date, +3 more": the first `max` names, then how many were left out. Empty list → ''. */
export function fieldsLine(names: readonly string[], max: number = ROW_FIELDS_MAX): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length <= max) return clean.join(', ');
  return `${clean.slice(0, max).join(', ')}, +${clean.length - max} more`;
}

/** At most this many options are spelled out; more than this reads as a range, "Triage → Canceled". */
export const OPTIONS_LISTED_MAX = 6;

/** "State (Backlog, Planned)" for a few options, "State (Triage → Canceled)" for many; a field with no options is its bare name. */
export function fieldLabel(name: string, options: readonly string[] | undefined): string {
  const opts = (options ?? []).map((o) => o.trim()).filter(Boolean);
  if (opts.length === 0) return name;
  if (opts.length <= OPTIONS_LISTED_MAX) return `${name} (${opts.join(', ')})`;
  return `${name} (${opts[0]} → ${opts[opts.length - 1]})`;
}

/**
 * The plain and workflow-state fields a person will see on a database, in order: state fields first, then plain fields
 * (manifest order). Relation fields are NOT here: they get their own line (`relationNames`), outside the cap. Derived
 * fields (formula/rollup/lookup) live in `derived_fields`, outside everything read here, and are left out.
 */
export function databaseFieldLabels(manifest: RowManifest | undefined, name: string): string[] {
  const m = manifest?.databases?.find((d) => d.name === name);
  const states = (manifest?.states ?? []).filter((s) => s.database === name);
  const stateNames = new Set(states.map((s) => s.field));
  return [
    ...states.map((s) =>
      fieldLabel(
        s.field,
        s.options?.map((o) => o.label),
      ),
    ),
    ...(m?.fields ?? [])
      .filter((f) => !stateNames.has(f.name))
      .map((f) =>
        fieldLabel(
          f.name,
          f.options?.map((o) => o.label),
        ),
      ),
  ];
}

/** The relation fields a database owns (`from_field`, on the `from` database); a to-side name belongs to the other database. */
export function relationNames(manifest: RowManifest | undefined, name: string): string[] {
  return (manifest?.relations ?? []).filter((r) => r.from === name).map((r) => r.from_field);
}

/** "Links to Project, Sprint, Release"; null when the database owns no relation. Never capped: a relation is the connection, not a column. */
export function linksLine(names: readonly string[]): string | null {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  return clean.length ? `Links to ${clean.join(', ')}` : null;
}

/** The muted line under a database row: "database · State (Triage → Canceled), Lead, …" (just "database" when no plain field is listed). */
function databaseSub(manifest: RowManifest | undefined, name: string): string {
  const line = fieldsLine(databaseFieldLabels(manifest, name));
  return line ? `database · ${line}` : 'database';
}

export function buildInstallRows(
  preview: {
    databases: PreviewRowItem[];
    views: PreviewRowItem[];
    automations: PreviewRowItem[];
    agents: PreviewRowItem[];
  },
  manifest: RowManifest | undefined,
): InstallRow[] {
  const rows: InstallRow[] = [];
  for (const item of preview.databases)
    rows.push({
      key: item.name,
      kind: 'database',
      name: item.name,
      sub: databaseSub(manifest, item.name),
      links: linksLine(relationNames(manifest, item.name)),
      action: item.action,
      note: itemEffect('database', item.action, item.gains),
      item,
    });
  for (const item of preview.views) {
    const m = manifest?.views?.find((v) => `${v.database}.${v.name}` === item.name);
    rows.push({
      key: item.name,
      kind: 'view',
      name: m?.name ?? item.name,
      sub: m ? `view of ${m.database}` : 'view',
      links: null,
      viewType: m?.type,
      action: item.action,
      note: itemEffect('view', item.action),
      item,
    });
  }
  for (const item of preview.automations) {
    const m = manifest?.automations?.find((a) => `${a.database}.${a.name}` === item.name);
    rows.push({
      key: item.name,
      kind: 'automation',
      name: m?.name ?? item.name,
      sub: m ? `automation · on ${m.database}` : 'automation',
      links: null,
      action: item.action,
      note: itemEffect('automation', item.action),
      item,
    });
  }
  for (const item of preview.agents) {
    const m = manifest?.agents?.find((a) => a.name === item.name);
    const goal = firstSentence(m?.goal);
    const gate = approvalSentence(m?.approval_policy);
    rows.push({
      key: item.name,
      kind: 'agent',
      name: item.name,
      links: null,
      sub: `agent · ${goal ? `${goal}. ` : ''}It works through your own AI.${gate ? ` ${gate}` : ''}`,
      action: item.action,
      // An agent this pack installed before is described by `agentEffect` (the dialog), not here.
      note: item.agent_update ? null : itemEffect('agent', item.action),
      item,
    });
  }
  return rows;
}

/** Rows that are not new — the ones that earn a note, and the ones the footer counts. */
export const notNew = (rows: InstallRow[]) => rows.filter((r) => r.action !== 'create');

/** The space the pack adds: its databases' own `space`, so the dialog can say WHERE it goes. Null when the manifest names none. */
export function packSpaceName(manifest: RowManifest | undefined): string | null {
  const spaces = [...new Set((manifest?.databases ?? []).map((d) => d.space).filter(Boolean))];
  return spaces.length === 1 ? spaces[0]! : null;
}

export const sampleRecordCount = (manifest: RowManifest | undefined) =>
  manifest?.sample_records?.length ?? 0;
