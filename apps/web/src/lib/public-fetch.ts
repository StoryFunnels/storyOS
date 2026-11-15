/**
 * Ticket #1291 — how a PUBLIC (signed-out) server page reads its resource, in one place so the four routes (form, skill share,
 * public view, pack landing) cannot disagree.
 *
 * - 404 / 403 / 401 / 400 / 422 are ONE answer, `null`: unknown, malformed, revoked, unpublished and private must be
 *   indistinguishable (a distinct "this one is private" page would be an existence oracle). The caller turns `null` into
 *   `notFound()`, which Next serves as a real HTTP 404.
 * - Anything else (5xx, a network error that makes `fetch` throw) is OUR failure and must NOT read as "not found": it throws, and
 *   the route's `error.tsx` offers a retry.
 */
export const NOT_FOUND_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

export class PublicLoadError extends Error {
  constructor(public readonly status: number) {
    super(`public read failed: HTTP ${status}`);
    this.name = 'PublicLoadError';
  }
}

export async function fetchPublicJson<T>(url: string | URL): Promise<T | null> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (NOT_FOUND_STATUSES.has(res.status)) return null;
  if (!res.ok) throw new PublicLoadError(res.status);
  return (await res.json()) as T;
}
