import { cn } from '@/lib/utils';
import { chipVariants } from '@/components/ui/chip';

/**
 * #663 — a template preview you can READ WITHOUT READING.
 *
 * The detail screen used to be ~200 words of markdown guide plus the schema as
 * dot-joined field names ("Status · Owner · Industry · Company Size · …"). That
 * is documentation about a product, on the one screen whose job is to make
 * someone want the product. Ievgen's bar for this screen was that the reaction
 * should be "I want this NOW", and prose cannot do that.
 *
 * So: draw the thing. Every view type has an instantly recognisable shape — a
 * board is columns of stacked cards, a calendar is a month grid, a timeline is
 * staggered bars — and the registry already tells us which views a template
 * creates. Nothing new is needed from the API; this is the same payload, shown
 * instead of described.
 *
 * These are ABSTRACTIONS, not screenshots. Deliberately: a screenshot would go
 * stale the first time any view changed, and would need one asset per template
 * per theme. Bars and blocks built from theme tokens follow the theme for free
 * and cannot drift from the product, because they never claimed to be it.
 */

const BAR = 'rounded-[2px] bg-border-strong';
const FAINT = 'rounded-[2px] bg-border-default';

/** The recognisable silhouette of each view type, at thumbnail size. */
function ViewShape({ type }: { type: string }) {
  switch (type) {
    case 'board':
      /* Columns of CHUNKY cards with wide gutters. The gutter and the block
         height are what separate this from `table` at 80px tall — an early
         version split table rows into three segments too, and at thumbnail size
         the two were indistinguishable, which fails the whole point. */
      return (
        <div className="flex h-full gap-2">
          {[3, 2, 4].map((n, col) => (
            <div key={col} className="flex flex-1 flex-col gap-1.5">
              <div className={cn(FAINT, 'h-1 w-2/3 rounded-full')} />
              {Array.from({ length: n }).map((_, i) => (
                <div key={i} className={cn(BAR, 'h-3.5')} />
              ))}
            </div>
          ))}
        </div>
      );
    case 'table':
      /* Many thin FULL-WIDTH rows under a header. Deliberately not split into
         column segments: a table does have columns, but at 80px the thing that
         reads is "lots of horizontal lines", and segmenting them made this
         identical to `board`. */
      return (
        <div className="flex h-full flex-col gap-[3px]">
          <div className={cn(BAR, 'h-2')} />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className={cn(FAINT, 'h-1.5')} />
          ))}
        </div>
      );
    case 'calendar':
      return (
        <div className="grid h-full grid-cols-7 grid-rows-4 gap-[3px]">
          {Array.from({ length: 28 }).map((_, i) => (
            <div key={i} className={cn(i % 6 === 2 ? BAR : FAINT, 'rounded-[1px]')} />
          ))}
        </div>
      );
    case 'timeline':
      return (
        <div className="flex h-full flex-col justify-center gap-1.5">
          {[
            'ml-0 w-1/2',
            'ml-[18%] w-2/5',
            'ml-[35%] w-1/2',
            'ml-[10%] w-1/3',
          ].map((pos, i) => (
            <div key={i} className={cn(BAR, 'h-2', pos)} />
          ))}
        </div>
      );
    case 'gallery':
      return (
        <div className="grid h-full grid-cols-3 grid-rows-2 gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={cn(BAR, 'rounded-[2px]')} />
          ))}
        </div>
      );
    case 'list':
      return (
        <div className="flex h-full flex-col justify-center gap-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className={cn(FAINT, 'h-1.5 w-1.5 rounded-full')} />
              <div className={cn(BAR, 'h-1.5 flex-1')} />
            </div>
          ))}
        </div>
      );
    case 'feed':
      return (
        <div className="flex h-full flex-col justify-center gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex gap-1.5">
              <div className={cn(FAINT, 'h-3 w-3 shrink-0 rounded-full')} />
              <div className="flex flex-1 flex-col gap-1">
                <div className={cn(BAR, 'h-1.5 w-2/3')} />
                <div className={cn(FAINT, 'h-1.5')} />
              </div>
            </div>
          ))}
        </div>
      );
    case 'form':
      return (
        <div className="flex h-full flex-col justify-center gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-[3px]">
              <div className={cn(FAINT, 'h-1 w-1/4')} />
              <div className="h-2.5 rounded-[2px] border border-border-strong" />
            </div>
          ))}
        </div>
      );
    case 'dashboard':
      return (
        <div className="grid h-full grid-cols-2 grid-rows-2 gap-1">
          <div className={cn(BAR, 'row-span-2')} />
          <div className={cn(FAINT)} />
          <div className={cn(BAR)} />
        </div>
      );
    default:
      /* #663 AC5 — an unknown view type degrades to a neutral block rather than
         an empty box. The registry's type list can grow without this file, and a
         blank thumbnail reads as a broken preview rather than a new view type. */
      return (
        <div className="flex h-full flex-col justify-center gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={cn(FAINT, 'h-2')} />
          ))}
        </div>
      );
  }
}

/** One view: its silhouette, its name, and what kind of view it is. */
export function ViewThumbnail({
  name,
  type,
  database,
}: {
  name: string;
  type: string;
  database?: string;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="h-20 rounded-[var(--radius-card)] border border-border-default bg-card p-2">
        <ViewShape type={type} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-ink">{name}</p>
        <p className="truncate text-meta uppercase tracking-wider text-muted">
          {database ? `${type} · ${database}` : type}
        </p>
      </div>
    </div>
  );
}

/**
 * The schema, as databases carrying typed fields.
 *
 * Fields render through the SHARED chip primitive (#533's `filled` variant), not
 * a fourth pill treatment — the field's TYPE is what a reader is actually
 * scanning for, and it was invisible in the dot-joined list this replaces.
 */
export function SchemaMap({
  databases,
  relations,
}: {
  databases: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
  relations: string[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {databases.map((db) => (
          <div
            key={db.name}
            className="rounded-[var(--radius-card)] border border-border-default bg-card p-2.5"
          >
            <p className="mb-1.5 text-body font-medium text-ink">{db.name}</p>
            <div className="flex flex-wrap gap-1">
              {db.fields.map((f) => (
                <span
                  key={f.name}
                  className={cn(chipVariants({ variant: 'outline' }), 'max-w-full')}
                  title={`${f.name} — ${f.type}`}
                >
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-muted">{f.type}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {relations.length > 0 && (
        <p className="text-meta text-muted">
          <span className="uppercase tracking-wider">Linked</span>{' '}
          {relations.join('  ·  ')}
        </p>
      )}
    </div>
  );
}
