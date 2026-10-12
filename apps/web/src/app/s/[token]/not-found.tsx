/**
 * Ticket #866 AC4 — rendered for an unknown, malformed OR revoked token, with a real HTTP 404.
 * One page, one wording: telling "never existed" from "was revoked" would let anyone holding a
 * token list probe which ones used to be live (an enumeration oracle), so the page deliberately
 * cannot say which it is. Nothing here may be made more specific.
 */
export default function PublicSkillNotFound() {
  return (
    <main className="min-h-screen bg-app px-4 py-12">
      <div className="mx-auto max-w-xl rounded-[var(--radius-card)] border border-border-default bg-card p-8 text-center">
        <h1 className="text-title font-semibold text-ink">This skill isn’t available</h1>
        <p className="mt-2 text-body text-muted">The link doesn’t exist, or it is no longer shared.</p>
      </div>
    </main>
  );
}
