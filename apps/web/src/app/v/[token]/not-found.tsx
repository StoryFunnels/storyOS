/**
 * #566 — rendered when `page.tsx` calls `notFound()`: an unknown token, a
 * revoked one, or one whose view/database has been soft-deleted. Next serves
 * this with a real HTTP 404 (unlike the previous client-only page, which
 * always answered 200). Deliberately generic — the four "missing" cases stay
 * indistinguishable from each other, matching PublicViewsService's own
 * uniform NotFoundException.
 */
export default function PublicViewNotFound() {
  return (
    <div className="min-h-screen bg-[#FAF7F1] px-4 py-12">
      <div className="mx-auto max-w-xl rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <h1 className="text-lg font-semibold text-neutral-900">View not found</h1>
        <p className="mt-2 text-sm text-neutral-500">This link doesn&rsquo;t exist or is no longer public.</p>
      </div>
    </div>
  );
}
