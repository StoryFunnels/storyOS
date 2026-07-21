'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Database, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases } from '@/lib/queries';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EntityIcon } from '@/components/ui/icon-picker';

/**
 * Mobile quick-capture (mobile-responsive-plan.md, MN-230c): "a fast 'new
 * record' from anywhere on mobile". Pick a database, land straight on the
 * new blank record to fill in. Desktop already has an equivalent (the
 * command palette's "New record here" + per-table "New" affordances), so
 * this FAB is mobile-only (md:hidden) — it exists for the surface that has
 * no shortcut at all: a phone, on any page, without a table in view.
 */
export function QuickAddFab() {
  const { ws } = useParams<{ ws: string }>();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const databases = useDatabases(ws);

  const create = useMutation({
    mutationFn: async (dbId: string) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: dbId } },
        body: { values: {} },
      });
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (created, dbId) => {
      setOpen(false);
      setQuery('');
      router.push(`/w/${ws}/d/${dbId}/r/${created.id}`);
    },
    onError: () => toast.error('Could not create record'),
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = databases.data ?? [];
    if (!q) return all;
    return all.filter((d) => d.name.toLowerCase().includes(q));
  }, [databases.data, query]);

  return (
    <>
      {/* z-20: below the mobile drawer (z-40) and its backdrop (z-30), so an
          open drawer naturally covers this instead of both fighting for taps. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Quick add a record"
        title="New record"
        className="fixed bottom-5 right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-[var(--text-on-dark)] shadow-[0_8px_24px_rgba(15,23,41,0.25)] hover:bg-primary-hover md:hidden"
      >
        <Plus className="h-6 w-6" />
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <DialogContent title="New record" className="max-w-sm">
          <Input
            autoFocus
            placeholder="Search databases…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-3"
          />
          <div className="-mx-2 max-h-[50vh] overflow-y-auto">
            {databases.isLoading && <p className="px-2 py-3 text-[13px] text-muted">Loading…</p>}
            {!databases.isLoading && filtered.length === 0 && (
              <p className="px-2 py-3 text-[13px] text-muted">No databases match.</p>
            )}
            {filtered.map((db) => (
              <button
                key={db.id}
                type="button"
                disabled={create.isPending}
                onClick={() => create.mutate(db.id)}
                className="flex min-h-[44px] w-full items-center gap-2.5 rounded px-2 py-2 text-left text-[14px] text-ink hover:bg-hover disabled:opacity-50"
              >
                <EntityIcon icon={db.icon} color={db.color} fallback={<Database className="h-4 w-4" />} />
                {db.name}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
