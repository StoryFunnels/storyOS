'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useDatabase } from '@/components/table-view/use-table-data';
import { DatabaseRelationsDiagram } from '@/components/database-relations-diagram';
import type { OntologyRelation } from '@/components/space-ontology';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { AddFieldDialog } from '@/components/table-view/add-field-dialog';

/**
 * #531 — a single database's own relations: this database at the center,
 * related databases as nodes, click to navigate. Deliberately NOT an editing
 * surface (Otto's ruling, recorded on the ticket): "+" opens the EXISTING
 * relation-field creation dialog verbatim rather than a second, inline
 * editor — cardinality changes are destructive (many-to-one throws data
 * away), and two code paths that both claim to create/edit a relation is
 * exactly how they drift apart. Independent of #528 (the space-level
 * ontology diagram): no shared component, since this surface didn't exist
 * before this ticket.
 */
export default function DatabaseRelationsPage() {
  const { ws, db } = useParams<{ ws: string; db: string }>();
  const router = useRouter();
  const database = useDatabase(ws, db);
  const [addOpen, setAddOpen] = useState(false);

  const relations = useQuery({
    queryKey: ['relations', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/relations', {
        params: { path: { ws }, query: { database: db } } as never,
      } as never);
      if (error) throw error;
      return (data as unknown as { data: OntologyRelation[] }).data;
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Relations — {database.data?.name ?? '…'}</h1>
        <Link href={`/w/${ws}/d/${db}`} className="text-[13px] text-muted hover:text-ink">
          Back to database
        </Link>
      </div>

      {database.data && (
        <DatabaseRelationsDiagram
          center={{ id: db, name: database.data.name, icon: database.data.icon, color: database.data.color }}
          relations={relations.data ?? []}
          onOpenDatabase={(id) => router.push(`/w/${ws}/d/${id}`)}
        />
      )}

      <div className="mt-4 flex justify-center">
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <Button type="button" variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New relation
          </Button>
          {addOpen && (
            <AddFieldDialog ws={ws} db={db} initialType="relation" onDone={() => setAddOpen(false)} />
          )}
        </Dialog>
      </div>
    </div>
  );
}
