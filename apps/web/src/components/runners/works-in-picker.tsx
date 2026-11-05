'use client';

import { Check, FolderClosed, Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import { DbMarker } from '@/components/entity/db-marker';
import { Button } from '@/components/ui/button';
import { chipVariants } from '@/components/ui/chip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { DatabaseSummary, Space } from '@/lib/queries';
import { apiAccepts } from '@/lib/runners/hire-capabilities';
import type { Caps } from '@/lib/runners/hire-capabilities';
import type { WorkTarget } from '@/lib/runners/hire';
import { addWork, isCovered, pickerGroups, removeWork } from '@/lib/runners/works-in';

/**
 * Ticket #1196 — "Works in": chips for what the agent may work in, and a searchable picker grouped by space. A database chip is
 * drawn with the database's own glyph (the sidebar's own, ticket #1207). A WHOLE SPACE is a row and a chip only once the API has a
 * space target (ticket #1195, `wholeSpaceTargets`): until then the space is a heading and only its databases can be added, so the
 * card never says "and any added later", which the API would not do.
 */
export function WorksInPicker({
  works,
  onChange,
  spaces,
  databases,
  caps,
}: {
  works: WorkTarget[];
  onChange: (works: WorkTarget[]) => void;
  spaces: readonly Space[];
  databases: readonly DatabaseSummary[];
  caps?: Caps;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wholeSpaces = apiAccepts('wholeSpaceTargets', caps);
  const groups = pickerGroups(spaces, databases, q);
  const dbById = new Map(databases.map((d) => [d.id, d]));

  return (
    <div data-testid="works-in">
      <div className="flex flex-wrap items-center gap-1.5">
        {works.length === 0 && <span className="text-label text-muted">Nothing yet.</span>}
        {works.map((w, i) => {
          const db = w.kind === 'db' ? dbById.get(w.id) : undefined;
          return (
            <span key={`${w.kind}:${w.id}`} className={cn(chipVariants({ variant: 'reference' }), 'gap-1.5 pr-1')} data-testid="works-chip">
              {w.kind === 'space' ? <FolderClosed className="h-3 w-3 shrink-0 text-muted" aria-hidden /> : <DbMarker icon={db?.icon} color={db?.color} id={w.id} />}
              <span className="truncate">{w.name}</span>
              {w.kind === 'space' && <small className="text-label text-muted">· whole space</small>}
              <button type="button" onClick={() => onChange(removeWork(works, i))} aria-label={`Remove ${w.name}`} className="grid h-4 w-4 place-items-center rounded text-muted hover:bg-hover hover:text-ink">
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          );
        })}
        <Popover
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (v) setQ('');
          }}
        >
          <PopoverTrigger asChild>
            <Button type="button" variant="secondary" size="sm" aria-haspopup="listbox">
              <Plus className="h-3 w-3" aria-hidden />
              {wholeSpaces ? 'Add a space or database' : 'Add a database'}
            </Button>
          </PopoverTrigger>
          {/* pointer-events-auto: inside the hire Dialog (modal) the body is pointer-events:none and this portalled list inherits it, so a real click fell THROUGH the list onto the dialog beneath (found live: a click on "Clients" ticked a checkbox). */}
          <PopoverContent align="start" className="pointer-events-auto w-[min(360px,calc(100vw-32px))] p-1.5">
            <label className="mb-1 flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default bg-card px-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={wholeSpaces ? 'Search spaces and databases' : 'Search databases'}
                aria-label="Search databases"
                className="h-8 w-full bg-transparent text-body text-ink outline-none placeholder:text-muted"
              />
            </label>
            <div role="listbox" aria-label={wholeSpaces ? 'Add a space or database' : 'Add a database'} className="max-h-[300px] overflow-y-auto">
              {groups.length === 0 && <p className="m-0 px-2 py-3 text-label text-muted">{q ? 'Nothing matches.' : 'There is no database to add yet.'}</p>}
              {groups.map(({ space, databases: dbs }) => {
                const spaceOn = works.some((w) => w.kind === 'space' && w.id === space.id);
                return (
                  <div key={space.id}>
                    {wholeSpaces ? (
                      <button
                        type="button"
                        disabled={spaceOn}
                        onClick={() => {
                          onChange(addWork(works, { kind: 'space', id: space.id, name: space.name }));
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-body font-semibold text-ink hover:bg-hover disabled:text-muted"
                      >
                        <FolderClosed className="h-3 w-3 shrink-0" aria-hidden />
                        {space.name}
                        <small className="ml-auto text-label font-normal text-muted">{spaceOn ? 'added' : `the whole space · ${dbs.length} ${dbs.length === 1 ? 'database' : 'databases'}`}</small>
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-micro font-semibold uppercase tracking-wider text-muted">{space.name}</div>
                    )}
                    {dbs.map((d) => {
                      const on = isCovered(works, d);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          role="option"
                          aria-selected={on}
                          disabled={on}
                          onClick={() => {
                            onChange(addWork(works, { kind: 'db', id: d.id, name: d.name, spaceId: d.spaceId }));
                            setOpen(false);
                          }}
                          className="flex w-full items-center gap-1.5 rounded-[var(--radius-control)] py-1.5 pl-5 pr-2 text-left text-body text-ink hover:bg-hover disabled:text-muted disabled:hover:bg-transparent"
                        >
                          <DbMarker icon={d.icon} color={d.color} id={d.id} />
                          <span className="min-w-0 flex-1 truncate">{d.name}</span>
                          {on && (
                            <small className="flex items-center gap-1 text-label text-muted">
                              <Check className="h-3 w-3" aria-hidden />
                              added
                            </small>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {wholeSpaces &&
        works
          .filter((w) => w.kind === 'space')
          .map((w) => {
            const names = databases.filter((d) => d.spaceId === w.id && !d.isSystem).map((d) => d.name);
            return (
              <p key={w.id} className="mb-0 mt-1 text-label text-muted">
                {w.name}: {names.length} {names.length === 1 ? 'database' : 'databases'} now ({names.join(', ')}), and any added to it later.
              </p>
            );
          })}
    </div>
  );
}
