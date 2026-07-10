import type { Client } from './client.js';
import { unwrap } from './client.js';

/**
 * Name-or-id resolution (MN-076). IDs only ever come from a prior tool result or
 * these resolvers — the model never invents them. Accepting human names/slugs is
 * the "easy" half; resolving them server-truthfully is the "non-hallucinated" half.
 */

export interface WorkspaceRef {
  id: string;
  name: string;
  slug?: string;
  role?: string;
}

export interface DatabaseRef {
  id: string;
  name: string;
  apiSlug?: string;
  spaceId?: string;
  icon?: string | null;
}

export async function listWorkspaces(client: Client): Promise<WorkspaceRef[]> {
  return unwrap<WorkspaceRef[]>(client.GET('/api/v1/workspaces'));
}

export async function resolveWorkspace(client: Client, ref: string): Promise<WorkspaceRef> {
  const list = await listWorkspaces(client);
  const lower = ref.trim().toLowerCase();
  const exact = list.find((w) => w.id === ref || w.name.toLowerCase() === lower || w.slug?.toLowerCase() === lower);
  if (exact) return exact;
  const partial = list.filter((w) => w.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`"${ref}" matches multiple workspaces: ${partial.map((w) => w.name).join(', ')}. Be more specific.`);
  }
  throw new Error(`No workspace matches "${ref}". Available: ${list.map((w) => w.name).join(', ') || '(none)'}.`);
}

export async function listDatabases(client: Client, workspaceId: string): Promise<DatabaseRef[]> {
  // The list op under-documents its {ws} path param in the OpenAPI spec, so the
  // typed client rejects it though the substitution works at runtime (as in the web).
  return unwrap<DatabaseRef[]>(
    client.GET('/api/v1/workspaces/{ws}/databases', { params: { path: { ws: workspaceId } } } as never),
  );
}

export async function resolveDatabase(client: Client, workspaceId: string, ref: string): Promise<DatabaseRef> {
  const list = await listDatabases(client, workspaceId);
  const lower = ref.trim().toLowerCase();
  const exact = list.find(
    (d) => d.id === ref || d.name.toLowerCase() === lower || d.apiSlug?.toLowerCase() === lower,
  );
  if (exact) return exact;
  const partial = list.filter((d) => d.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`"${ref}" matches multiple databases: ${partial.map((d) => d.name).join(', ')}. Be more specific.`);
  }
  throw new Error(`No database matches "${ref}" in this workspace. Available: ${list.map((d) => d.name).join(', ') || '(none)'}.`);
}
