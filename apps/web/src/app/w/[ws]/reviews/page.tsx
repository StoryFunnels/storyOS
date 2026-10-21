'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * #968 — Reviews now lives in My Work as the "Pull requests" tab. This route stays only so an old link or
 * bookmark lands somewhere true; `replace`, so Back does not return to a page that immediately bounces on.
 * (The PR detail pages under /reviews/[owner]/[repo]/[number] are unchanged.)
 */
export default function ReviewsRedirect() {
  const { ws } = useParams<{ ws: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/w/${ws}/me?tab=pull-requests`);
  }, [ws, router]);
  return null;
}
