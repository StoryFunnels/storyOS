import { parseDateText } from '@/components/ui/date-picker';

/**
 * Ticket #1189 — the Audit log's filters as plain data, so what is sent to the API, what counts as "a filter is on" and what the
 * closed "Filter" disclosure says about itself can be tested without rendering.
 *
 * The filters sit under a labelled "Advanced" (Dara's #974 design), which means a person can leave them closed with some applied. The
 * summary line says so ("2 applied") so a log that looks short is never a mystery. Dates are typed text parsed by the shared forgiving
 * parser the date cells use (ISO, 15.07, "jul 15", today, yesterday), not a native date input: Settings has no native pickers
 * (Dara's ruling on ticket #1191).
 *
 * "Unconfigured is not invalid" and the reverse: a date box that does not parse yet (mid-typing) is NOT sent, and is reported
 * separately so the page can say why, instead of silently filtering to nothing or silently ignoring it.
 */
export interface AuditFilterInput {
  actor: string;
  type: string;
  entity: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterInput = { actor: '', type: '', entity: '', from: '', to: '' };

export interface AuditQuery {
  actor?: string;
  entity?: string;
  type?: string;
  from?: string;
  to?: string;
}

export interface ResolvedAuditFilters {
  /** What is sent to `GET /workspaces/{ws}/audit-log`: only the filters that are set and valid. */
  query: AuditQuery;
  /** A typed date that does not parse (yet): not sent. */
  invalid: Array<'from' | 'to'>;
  /** How many filters are actually applied. */
  applied: number;
}

export function resolveAuditFilters(input: AuditFilterInput): ResolvedAuditFilters {
  const query: AuditQuery = {};
  const invalid: Array<'from' | 'to'> = [];
  if (input.actor) query.actor = input.actor;
  if (input.type) query.type = input.type;
  const entity = input.entity.trim();
  if (entity) query.entity = entity;
  for (const key of ['from', 'to'] as const) {
    const text = input[key].trim();
    if (!text) continue;
    const day = parseDateText(text);
    if (day) query[key] = new Date(day).toISOString();
    else invalid.push(key);
  }
  return { query, invalid, applied: Object.keys(query).length };
}

/** The line after "Filter" in the closed disclosure: what is inside, or how many are on. */
export function auditFilterSummary(applied: number): string {
  const inside = 'actor, type, record, dates';
  return applied === 0 ? inside : `${inside} · ${applied} applied`;
}
