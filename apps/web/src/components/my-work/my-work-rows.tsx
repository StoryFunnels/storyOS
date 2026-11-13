'use client';

import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight, Database, ExternalLink, MoreHorizontal } from 'lucide-react';
import { CellDisplay } from '@/components/table-view/cells';
import { EntityIcon } from '@/components/ui/icon-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import { recordSegment } from '@/lib/records';
import { cn } from '@/lib/utils';
import { HIT_AREA_24 } from '@/components/ui/header-action';
import {
  MyWorkGroupToolbar,
  rowColor,
  toField,
  visibleFields,
  type DenseField,
  type MyWorkDbConfig,
} from './group-config';
import { ASSIGNED_BY_UNRECORDED_DETAIL, ASSIGNED_BY_UNRECORDED_LABEL, assignedByLine, dueBucket, type MyWorkRow } from './my-work-model';
import { databaseColor } from '@/lib/entity-color';

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
export function DueText({
  due,
  fmtDate,
  now,
  completed = false,
}: {
  due: string | null;
  fmtDate: (iso: string) => string;
  now: Date;
  /** #1002 — the record is finished: its date reads plain, never as overdue. */
  completed?: boolean;
}) {
  const bucket = dueBucket(due, now, completed);
  if (bucket === 'none' || !due) return null;
  return (
    <span
      data-due={bucket}
      className={cn(
        // 10px like the design's date, with its 12px line so the row is not held open by the date's leading. The split
        // (overdue red / today ink / later plain) is the build's own, kept on purpose (ticket #1280 item 4).
        'text-micro leading-3 tabular-nums',
        bucket === 'today' && 'font-semibold text-ink',
        bucket === 'overdue' && 'font-medium text-error',
        // Muted, not faint: a date is something you read, and --text-faint is 3.2:1 on the page (below the 4.5 bar).
        (bucket === 'later' || bucket === 'done') && 'text-muted',
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
  const meta = [record.number != null ? `#${record.number}` : null, row.databaseLabel, facets.priority?.label].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      data-testid="my-work-row"
      data-key={rowKey(row)}
      onClick={onSelect}
      aria-current={selected === 'explicit' ? 'true' : undefined}
      style={tint ? { boxShadow: `inset 3px 0 0 ${tint}` } : undefined}
      className={cn(
        'flex w-full items-start gap-2.5 border-b border-border-default px-4 py-2.5 text-left hover:bg-hover',
        selected === 'explicit' && 'bg-active',
        selected === 'implicit' && 'md:bg-active',
      )}
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        <EntityIcon icon={database.icon} color={databaseColor(database.color, database.id)} fallback={<Database className="h-3.5 w-3.5" />} />
      </span>
      <span className="min-w-0 flex-1">
        <span data-mw-title className="block truncate text-body font-semibold leading-snug text-ink">
          {record.title || 'Untitled'}
        </span>
        <span className="block truncate text-label leading-tight text-muted">{meta}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {facets.state && <FacetCell field={facets.stateField} row={row} />}
        <DueText due={facets.due} fmtDate={fmtDate} now={now} completed={facets.completed} />
      </span>
    </button>
  );
}

/**
 * Ticket #1280 item 7 — the "Done · N" heading. A real button (keyboard reachable, aria-expanded, aria-controls) that opens
 * the finished rows beneath it; closed by default. Its state is page state only: nothing is remembered anywhere.
 */
export function DoneGroupHeader({
  heading,
  open,
  onToggle,
  controlsId,
}: {
  heading: string;
  open: boolean;
  onToggle: () => void;
  controlsId: string;
}) {
  return (
    <button
      type="button"
      data-testid="my-work-done-toggle"
      aria-expanded={open}
      aria-controls={controlsId}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 border-b border-border-default bg-hover/40 px-4 py-1.5 text-left text-label font-medium text-muted hover:text-ink"
    >
      {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span>{heading}</span>
    </button>
  );
}

/** A database section (Group = Database): the header and a ⋯ holding that database's own settings. */
export function SectionHeader({
  ws,
  database,
  label,
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
  /** The database as the rows name it (`databaseLabel`): with its space when another database shares the name. */
  label?: string;
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
        <EntityIcon icon={database.icon} color={databaseColor(database.color, database.id)} fallback={<Database className="h-3.5 w-3.5" />} />
        <span className="truncate">{label ?? database.name}</span>
        <span className="text-faint">{count}</span>
      </Link>
      <span className="flex-1" />
      {fields.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={`${database.name} settings`} className={cn(HIT_AREA_24, 'rounded p-0.5 text-faint hover:bg-hover hover:text-ink')}>
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
  tab,
  onBack,
  fmtDate,
  now,
  memberNames,
  memberImages,
}: {
  ws: string;
  row: MyWorkRow;
  /** Which list the row came from: "Assigned by" only means something on Assigned. */
  tab: 'assigned' | 'created';
  onBack: () => void;
  fmtDate: (iso: string) => string;
  now: Date;
  memberNames: Map<string, string>;
  memberImages: Map<string, string | null>;
}) {
  const { record, database, facets, fields, config } = row;
  const shown = new Set([facets.stateField?.id, facets.priorityField?.id, facets.dueField?.id]);
  const extra = visibleFields(fields, config).filter((f) => !shown.has(f.id) && record.values[f.api_name] != null);
  const assigned = assignedByLine(record, tab);
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
            {row.databaseLabel}
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
        <Fact label="Due">{facets.due ? <DueText due={facets.due} fmtDate={fmtDate} now={now} completed={facets.completed} /> : null}</Fact>
        {assigned.kind === 'set' && (
          <Fact label="Assigned by">
            <span>
              {assigned.name}
              {assigned.byAgent && (
                <span className="ml-1.5 rounded-full bg-hover px-1.5 py-0.5 text-meta font-medium text-muted">agent</span>
              )}
              {assigned.at && <span className="text-muted"> · {fmtDate(assigned.at)}</span>}
            </span>
          </Fact>
        )}
        {assigned.kind === 'unrecorded' && (
          <Fact label="Assigned by">
            <Tooltip label={ASSIGNED_BY_UNRECORDED_DETAIL} side="top" align="start">
              <span tabIndex={0} className="cursor-help text-muted">
                {ASSIGNED_BY_UNRECORDED_LABEL}
                {/* The reason is a tooltip for the mouse and keyboard; this keeps it for a screen reader too. */}
                <span className="sr-only">. {ASSIGNED_BY_UNRECORDED_DETAIL}</span>
              </span>
            </Tooltip>
          </Fact>
        )}
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
