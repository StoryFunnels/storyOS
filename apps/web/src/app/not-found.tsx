import { QuillNotFound } from '@/components/quill/not-found-view';

/** #1253 — any URL the router does not know (outside a workspace, so no sidebar around it). */
export default function NotFound() {
  return (
    <main className="min-h-screen bg-app">
      <QuillNotFound />
    </main>
  );
}
