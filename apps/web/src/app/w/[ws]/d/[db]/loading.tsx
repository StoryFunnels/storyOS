'use client';

import { useParams } from 'next/navigation';
import { DatabasePageSkeleton } from '@/components/views/database-page-skeleton';

/** #998 — the route's loading boundary: the same skeleton the page itself shows while the database detail loads. */
export default function Loading() {
  const { ws, db } = useParams<{ ws: string; db: string }>();
  return <DatabasePageSkeleton ws={ws} db={db} />;
}
