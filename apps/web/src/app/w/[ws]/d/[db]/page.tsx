'use client';

import { useParams } from 'next/navigation';
import { TableView } from '@/components/table-view/table-view';
import { useWorkspace } from '@/lib/queries';

export default function DatabasePage() {
  const { ws, db } = useParams<{ ws: string; db: string }>();
  const workspace = useWorkspace(ws);
  return <TableView ws={ws} db={db} readOnly={workspace.data?.role === 'guest'} />;
}
