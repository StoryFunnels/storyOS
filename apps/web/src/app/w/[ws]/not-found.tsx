import { QuillNotFound } from '@/components/quill/not-found-view';

/** #1253 — a page inside a workspace that does not exist: drawn inside the app shell, so the sidebar stays. */
export default function WorkspaceNotFound() {
  return <QuillNotFound />;
}
