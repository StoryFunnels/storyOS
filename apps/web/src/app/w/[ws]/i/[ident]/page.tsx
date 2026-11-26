'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { entityQueryOptions, entityState } from '@/lib/entity-state';
import { entityGateView } from '@/components/quill/entity-gate';
import { recordHref } from '@/lib/records';

/**
 * Ticket #1363 — `/w/{ws}/i/ISSUE-5201` opens the record with that identifier.
 *
 * The page is only a door: the API resolves the prefix to its database through the same access check every record route uses, and this
 * route redirects to the record's own page. A prefix nobody has, a database this person cannot see and a number that does not exist all
 * come back as the same 404, so they all land on the same not-found page here (#1291: 404 and 403 alike). A failed load says so rather
 * than drawing "nothing here" (#346).
 */
interface IdentifiedRecord {
  id: string;
  title: string;
  number: number | null;
  database_id: string;
}

export default function OpenByIdentifierPage() {
  const { ws, ident } = useParams<{ ws: string; ident: string }>();
  const router = useRouter();
  const identifier = decodeURIComponent(ident);
  const query = useQuery({
    queryKey: ['record-by-identifier', ws, identifier],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/records/by-identifier/{identifier}', {
        params: { path: { ws, identifier } },
      } as never);
      if (error) throw error;
      return data as unknown as IdentifiedRecord;
    },
    ...entityQueryOptions,
  });

  const record = query.data;
  useEffect(() => {
    if (record) router.replace(recordHref(ws, record.database_id, record));
  }, [record, router, ws]);

  const blocked = entityGateView(entityState(query), () => void query.refetch());
  if (blocked) return blocked;
  return <p className="p-6 text-sm text-muted">Opening {identifier}…</p>;
}
