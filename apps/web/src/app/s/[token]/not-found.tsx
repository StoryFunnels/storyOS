import { PublicNotFound } from '@/components/quill/not-found-view';

/** Ticket #1291 — unknown, revoked, unpublished or private: one page, the shared Quill 404, no app shell. */
export default function NotFound() {
  return (
    <main className="min-h-screen bg-app">
      <PublicNotFound />
    </main>
  );
}
