'use client';

import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight, Database, ExternalLink, MoreHorizontal } from 'lucide-react';
import { CellDisplay } from '@/components/table-view/cells';
import { EntityIcon } from '@/components/ui/icon-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { recordSegment } from '@/lib/records';
import { cn } from '@/lib/utils';
import {
  MyWorkGroupToolbar,
  rowColor,
  toField,
  visibleFields,
  type DenseField,
  type MyWorkDbConfig,
} from './group-config';
import { dueBucket, type MyWorkRow } from './my-work-model';

export const rowKey = (row: Pick<MyWorkRow, 'dbId' | 'record'>) => `${row.dbId}:${row.record.id}`;

/**
 * State / Priority as a chip, drawn by the shared cell renderer (`table-view/cells.tsx`) — never re-drawn here:
 * a surface that re-implements "how do I draw a select value" is the defect field-surfaces.md exists for.
 */
/** State and Priority are option fields, never people, so there are no names to look up. */
const NO_NAMES = new Map<string, string>();

function FacetCell({ field, row }: { field: DenseField | null; row: MyWorkRow }) {
  if (!field || row.record.values[field.api_name] == null) return null;
  return <CellDisplay field={toField(field)} value={row.record.values[field.api_name]} memberNames={NO_NAMES} />;
}

/** The due date as the row reads it: today emphasised, overdue in red, later plain. */
export function DueText({ due, fmtDate, now }: { due: string | null; fmtDate: (iso: string) => string; now: Date }) {
  const bucket = dueBucket(due, now);
  if (bucket === 'none' || !due) return null;
  return (
    <span
      data-due={bucket}
      className={cn(
        'text-meta tabular-nums',
        bucket === 'today' && 'font-semibold text-ink',
        bucket === 'overdue' && 'font-medium text-error',
        bucket === 'later' && 'text-faint',
      )}
    >
      {bucket === 'today' ? 'Today' : fmtDate(due)}
    </span>
  );
}

/**
 * One Inbox-shaped row: database icon (in its source colour) · title · "#932 · Issues · Urgent" · state pill and
 * due date on the right. EVERY title starts at the same x, because the leading slot is a fixed 16px icon box and
 * the ticket number lives in the meta line, not in front of the title (the old rows were pushed ~70px right by it).
 */
export function MyWorkRowButton({
  row,
  selected,
  onSelect,
  fmtDate,
  now,
}: {
  row: MyWorkRow;
  /** 'explicit' = the person picked it; 'implicit' = desktop's default preview of the first row (not highlighted on a phone, where nothing is open). */
  selected: 'explicit' | 'implicit' | false;
  onSelect: () => void;
  fmtDate: (iso: string) => string;
  now: Date;
}) {
  const { record, database, facets, config, fields } = row;
  const tint = rowColor(record.values, fields, config);
  const meta = [record.number != null ? `#${record.number}` : null, database.name, facets.priority?.label].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      data-testid="my-work-row"
      data-key={rowKey(row)}
      onClick={onSelect}
      aria-current={selected === 'explicit' ? 'true' : undefined}
      style={tint ? { boxShadow: `inset 3px 0 0 ${tint}` } : undefined}
      className={cn(
        'flex w-full items-start gap-2.5 border-b border-border-default px-4 py-3 text-left hover:bg-hover',
        selected === 'explicit' && 'bg-active',
        selected === 'implicit' && 'md:bg-active',
      )}
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        <EntityIcon icon={database.icon} color={database.color} fallback={<Database className="h-3.5 w-3.5" />} />
      </span>
      <span className="min-w-0 flex-1">
        <span data-mw-title className="block truncate text-body font-medium text-ink">
          {record.title || 'Untitled'}
        </span>
        <span className="block truncate text-label text-muted">{meta}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {facets.state && <FacetCell field={facets.stateField} row={row} />}
        <DueText due={facets.due} fmtDate={fmtDate} now={now} />
      </span>
    </button>
  );
}

/** A database section (Group = Database): the header and a ⋯ holding that database's own settings. */
export function SectionHeader({
  ws,
  database,
  count,
  collapsed,
  onToggle,
  fields,
  config,
  members,
  onChange,
}: {
  ws: string;
  database: MyWorkRow['database'];
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  fields: DenseField[];
  config: MyWorkDbConfig;
  members: Array<{ id: string; name: string }>;
  onChange: (next: MyWorkDbConfig) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border-default bg-hover/40 px-4 py-1.5 text-label font-medium text-muted">
      <button type="button" onClick={onToggle} aria-label={collapsed ? `Expand ${database.name}` : `Collapse ${database.name}`} className="flex h-4 w-4 shrink-0 items-center justify-center hover:text-ink">
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      <Link href={`/w/${ws}/d/${database.id}`} className="flex min-w-0 items-center gap-1.5 hover:text-ink">
        <EntityIcon icon={database.icon} color={database.color} fallback={<Database className="h-3.5 w-3.5" />} />
        <span className="truncate">{database.name}</span>
        <span className="text-faint">{count}</span>
      </Link>
      <span className="flex-1" />
      {fields.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={`${database.name} settings`} className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-2">
            <p className="mb-1.5 px-1 text-label font-semibold text-ink">{database.name}</p>
            <MyWorkGroupToolbar fields={fields} config={config} members={members} onChange={onChange} />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** The preview pane: State, Priority, Due, plus the database's own visible fields, and an Open button. */
export function MyWorkPreview({
  ws,
  row,
  onBack,
  fmtDate,
  now,
  memberNames,
  memberImages,
}: {
  ws: string;
  row: MyWorkRow;
  onBack: () => void;
  fmtDate: (iso: string) => string;
  now: Date;
  memberNames: Map<string, string>;
  memberImages: Map<string, string | null>;
}) {
  const { record, database, facets, fields, config } = row;
  const shown = new Set([facets.stateField?.id, facets.priorityField?.id, facets.dueField?.id]);
  const extra = visibleFields(fields, config).filter((f) => !shown.has(f.id) && record.values[f.api_name] != null);
  return (
    <div className="mx-auto max-w-2xl">
      <button type="button" onClick={onBack} className="mb-3 flex items-center gap-1 text-body text-muted hover:text-ink md:hidden">
        <ArrowLeft className="h-3.5 w-3.5" /> My Work
      </button>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-prose font-medium text-ink">{record.title || 'Untitled'}</p>
          <p className="text-label text-muted">
            {record.number != null && <>#{record.number} · </>}
            {database.name}
          </p>
        </div>
        <Link
          href={`/w/${ws}/d/${database.id}/r/${recordSegment(record)}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] bg-primary px-3 py-1.5 text-label font-medium text-[var(--text-on-dark)] hover:bg-primary-hover"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open
        </Link>
      </div>
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2.5 rounded-[var(--radius-card)] border border-border-default bg-card p-4 text-body">
        <Fact label="State">{facets.state ? <FacetCell field={facets.stateField} row={row} /> : null}</Fact>
        <Fact label="Priority">{facets.priority ? <FacetCell field={facets.priorityField} row={row} /> : null}</Fact>
        <Fact label="Due">{facets.due ? <DueText due={facets.due} fmtDate={fmtDate} now={now} /> : null}</Fact>
        {extra.map((f) => (
          <Fact key={f.id} label={f.display_name}>
            <CellDisplay field={toField(f)} value={record.values[f.api_name]} memberNames={memberNames} memberImages={memberImages} />
          </Fact>
        ))}
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-label text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children ?? <span className="text-faint">—</span>}</dd>
    </>
  );
}
