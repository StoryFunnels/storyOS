'use client';

import { Database as DatabaseIcon } from 'lucide-react';
import { EntityIconChip } from '@/components/ui/icon-picker';
import { useDatabases } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** One grey bar. Pulses unless the person asked for less motion. */
function Bar({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block rounded bg-hover motion-safe:animate-pulse', className)} />;
}

/** How many placeholder rows fill the grid area: enough to read as a table, few enough to stay cheap. */
export const SKELETON_ROWS = 9;

/**
 * #998 — what the main panel shows between the click and the database's detail arriving, in place of a bare
 * "Loading…". It draws the page's own chrome — the header (name, icon and colour come from the sidebar's already-cached
 * list, so they are usually real, not grey), a tab bar, the toolbar and a few grid rows — so the click is answered
 * at once and nothing jumps when the real page replaces it. It is also the route's `loading.tsx`.
 */
export function DatabasePageSkeleton({ ws, db }: { ws: string; db: string }) {
  const databases = useDatabases(ws);
  const known = databases.data?.find((d) => d.id === db);
  return (
    <div className="flex h-full flex-col" role="status" aria-busy="true" aria-label={known ? `Loading ${known.name}` : 'Loading'}>
      <div className="flex h-11 items-center gap-1 border-b border-border-default px-3">
        <h1 className="mr-3 flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink">
          {known ? (
            <>
              <EntityIconChip
                icon={known.icon}
                color={known.color ?? null}
                size={15}
                fallback={<DatabaseIcon className="h-3.5 w-3.5 text-faint" />}
                className={cn('h-6 w-6', !known.color && 'border border-transparent')}
              />
              {known.name}
            </>
          ) : (
            <Bar className="h-4 w-28" />
          )}
        </h1>
        <Bar className="ml-2 h-5 w-24" />
        <Bar className="h-5 w-20" />
      </div>
      <div className="flex h-10 items-center gap-2 border-b border-border-default px-3">
        <Bar className="h-5 w-16" />
        <Bar className="h-5 w-14" />
        <Bar className="h-5 w-14" />
        <span className="flex-1" />
        <Bar className="h-5 w-20" />
      </div>
      <div className="flex-1 overflow-hidden">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-6 border-b border-border-default px-3">
            <Bar className="h-3.5 w-4 shrink-0" />
            <Bar className={cn('h-3.5', i % 3 === 0 ? 'w-56' : i % 3 === 1 ? 'w-44' : 'w-64')} />
            <Bar className="h-3.5 w-24 max-md:hidden" />
            <Bar className="h-3.5 w-20 max-md:hidden" />
          </div>
        ))}
      </div>
    </div>
  );
}
