import { API_URL } from '@/lib/api';

/**
 * Upload an image for a BlockNote editor (MN-097) → returns a servable URL for the
 * image block's `src`. Same-origin in prod (behind Caddy), absolute in dev; the
 * serve endpoint is a public capability URL so the <img> loads without cookies/CORS.
 */
export async function uploadEditorImage(ws: string, file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_URL}/api/v1/workspaces/${ws}/files`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? 'Upload failed');
  }
  const { url } = (await res.json()) as { url: string };
  return url.startsWith('http') ? url : `${API_URL}${url}`;
}
