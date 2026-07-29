'use client';

import { useParams } from 'next/navigation';
import { RecordSurface } from '@/components/entity/split-screen-host';

/**
 * Record-page route: a thin shell (#146, plan §3.1). It resolves the route params
 * and hands them to `RecordSurface`, which renders the reusable `RecordDetail`
 * body — the same component a split-screen side panel renders — and owns the
 * optional second-pane split. The full-page experience is unchanged when no panel
 * is open.
 */
export default function EntityPage() {
  const { ws, db, rec } = useParams<{ ws: string; db: string; rec: string }>();
  return <RecordSurface ws={ws} db={db} rec={rec} />;
}
