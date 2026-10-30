import { richTextPreview } from '@/components/table-view/cell-text';
import type { WakeSummary, WakeSummaryAgent } from './types';

/**
 * Ticket #1139 — an agent as the agent page needs it, read from its record in the Agents system database.
 *
 * An agent IS a record: `created_by` is its owner (ADR-0021 Q2, "manager = the agent's owner"), `values` are keyed by api_name,
 * and a select / multi-select stores option ids that the database's field list turns into labels.
 */
export interface AgentRecordLike {
  id: string;
  title: string;
  values: Record<string, unknown>;
  created_by: string | null;
  created_at?: string;
}

export interface FieldWithOptions {
  apiName: string;
  options?: Array<{ id: string; label: string }>;
}

export type AiMode = 'Non-AI' | 'Your own AI' | 'StoryOS AI' | null;

export interface AgentView {
  id: string;
  name: string;
  ownerId: string | null;
  enabled: boolean;
  aiMode: AiMode;
  /** Only an enabled agent in "Your own AI" mode is served by a Runner; every other agent keeps today's behaviour. */
  usesRunner: boolean;
  job: string;
  asksBefore: string[];
  /** When the agent record was created: "Hired 30 Oct". Null when the API did not say. */
  hiredAt: string | null;
}

function labelOf(value: unknown, field: FieldWithOptions | undefined): string | null {
  if (typeof value !== 'string') return null;
  return field?.options?.find((o) => o.id === value)?.label ?? null;
}

function labelsOf(value: unknown, field: FieldWithOptions | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map((field?.options ?? []).map((o) => [o.id, o.label]));
  return value.map((id) => byId.get(String(id))).filter((l): l is string => Boolean(l));
}

export function toAgentView(rec: AgentRecordLike, fields: readonly FieldWithOptions[]): AgentView {
  const f = (apiName: string) => fields.find((x) => x.apiName === apiName);
  const mode = labelOf(rec.values['ai_mode'], f('ai_mode'));
  const aiMode: AiMode = mode === 'Non-AI' || mode === 'Your own AI' || mode === 'StoryOS AI' ? mode : null;
  const enabled = rec.values['enabled'] === true;
  return {
    id: rec.id,
    name: rec.title,
    ownerId: rec.created_by,
    enabled,
    aiMode,
    usesRunner: enabled && aiMode === 'Your own AI',
    job: richTextPreview(rec.values['goal'], 400),
    asksBefore: labelsOf(rec.values['approval_policy'], f('approval_policy')),
    hiredAt: rec.created_at ?? null,
  };
}

/** What the page says an approval policy label means in plain words (the Agents database stores the machine names). */
const HOLD_WORDS: Record<string, string> = {
  email: 'Sending email',
  webhook: 'Calling another service',
  outward: 'Anything that leaves the workspace',
  delete: 'Deleting anything',
  run_button: 'Pressing a run button',
};

export function asksBeforeLine(labels: readonly string[]): string {
  return labels.map((l) => HOLD_WORDS[l] ?? l).join(' · ');
}

/**
 * The count the sidebar's Agents row carries (Otto's AC1): agents that SHOULD be working and cannot, because no Runner serves
 * them. The server derives it (`agents_that_cannot_run`), already filtered to what the viewer may read; this only decides
 * whether to draw it. Zero draws nothing: a "0" badge is noise, and an absent summary is not a zero.
 */
export function cannotRunCount(summary: Pick<WakeSummary, 'agents_that_cannot_run'> | undefined): number | null {
  const n = summary?.agents_that_cannot_run;
  return typeof n === 'number' && n > 0 ? n : null;
}

/** One agent's row in the summary, if the viewer's summary has one. */
export function summaryFor(summary: WakeSummary | undefined, agentId: string): WakeSummaryAgent | undefined {
  return summary?.agents.find((a) => a.agent_id === agentId);
}

/**
 * "1 record is waiting for it" / "3 records are waiting for it". The number comes from the API's own `waiting` count for this
 * agent (`GET .../agent-wakes/summary`): a real quantity, never one counted here from a page of rows (ticket #404's lesson).
 */
export function waitingLine(n: number): string {
  return n === 1 ? '1 record is waiting for it' : `${n} records are waiting for it`;
}
