import { notFound } from 'next/navigation';

/**
 * #1253 — any URL under a workspace that no route matches. Without this Next renders the app-root 404, which has no sidebar around it;
 * calling notFound() here hands it to `w/[ws]/not-found.tsx`, drawn INSIDE the workspace shell. Static routes win over a catch-all, so
 * nothing that exists is shadowed.
 */
export default function UnknownWorkspacePath() {
  notFound();
}
