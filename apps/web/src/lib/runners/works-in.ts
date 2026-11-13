import type { DatabaseSummary, Space } from '@/lib/queries';
import type { WorkTarget } from './hire';

/**
 * Ticket #1196 — the "Works in" picker's list: the databases a person may point an agent at, grouped by space, searchable.
 *
 * Left out, and why: a SYSTEM database (Agents, Runs, Triggers, Members: an agent is not pointed at the machinery that runs agents,
 * and Members holds every colleague's email), and anything in a PERSONAL space (private even from admins, and an agent acts for
 * its manager, never inside someone's private space; personal content is documents and views, not databases, in v1).
 */
/**
 * THE one answer to "may an agent work in this database?" as far as system databases go. Identity is the `is_system` FLAG, never
 * the display name: a person's own database called "Members" has the flag off and stays (ADR-0017). The hire picker, the rule picker
 * and the agent page's "Works in" row all call this, so they cannot disagree about which databases count.
 */
export function isAgentWorkable(d: { isSystem?: boolean }): boolean {
  return !d.isSystem;
}

export interface PickerGroup {
  space: Pick<Space, 'id' | 'name' | 'icon' | 'color'>;
  databases: DatabaseSummary[];
}

export function pickerGroups(spaces: readonly Space[], databases: readonly DatabaseSummary[], query: string): PickerGroup[] {
  const q = query.trim().toLowerCase();
  const out: PickerGroup[] = [];
  for (const space of [...spaces].sort((a, b) => a.position - b.position)) {
    if (space.personal) continue;
    const own = databases.filter((d) => d.spaceId === space.id && isAgentWorkable(d)).sort((a, b) => a.position - b.position);
    const spaceHit = q !== '' && space.name.toLowerCase().includes(q);
    // A search that names the SPACE shows all of it; one that names a database shows only the databases that match.
    const shown = q === '' || spaceHit ? own : own.filter((d) => d.name.toLowerCase().includes(q));
    if (shown.length > 0) out.push({ space, databases: shown });
  }
  return out;
}

/** Whether this database is already a chip (directly, or through a space target the API supports). */
export function isCovered(works: readonly WorkTarget[], db: Pick<DatabaseSummary, 'id' | 'spaceId'>): boolean {
  return works.some((w) => (w.kind === 'db' ? w.id === db.id : w.id === db.spaceId));
}

/** Choosing a database adds one chip; choosing a space (only once the API has space targets) replaces that space's database chips. */
export function addWork(works: readonly WorkTarget[], target: WorkTarget): WorkTarget[] {
  if (target.kind === 'db') return works.some((w) => w.kind === 'db' && w.id === target.id) ? [...works] : [...works, target];
  const rest = works.filter((w) => !(w.kind === 'db' && w.spaceId === target.id) && !(w.kind === 'space' && w.id === target.id));
  return [...rest, target];
}

export function removeWork(works: readonly WorkTarget[], index: number): WorkTarget[] {
  return works.filter((_, i) => i !== index);
}

/**
 * The databases a wake rule may watch: the ones named, plus every non-system database inside a WHOLE-SPACE chip (ticket #1289 item 7).
 * Without the second half a space chip would leave the rule picker empty, which reads as "this agent can work nowhere".
 */
export function watchableDatabases(works: readonly WorkTarget[], databases: readonly DatabaseSummary[]): Extract<WorkTarget, { kind: 'db' }>[] {
  const out = new Map<string, Extract<WorkTarget, { kind: 'db' }>>();
  for (const w of works) if (w.kind === 'db') out.set(w.id, w);
  const spaceIds = new Set(works.filter((w) => w.kind === 'space').map((w) => w.id));
  for (const d of databases) {
    if (isAgentWorkable(d) && spaceIds.has(d.spaceId) && !out.has(d.id)) out.set(d.id, { kind: 'db', id: d.id, name: d.name, spaceId: d.spaceId });
  }
  return [...out.values()];
}
