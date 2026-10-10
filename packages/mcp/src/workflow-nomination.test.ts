import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';

/**
 * #598 — the two tools over the workflow-nomination endpoints. What is worth testing HERE is what the
 * tool layer owns: it translates names to ids, it DEFAULTS TO A DRY RUN (a schema change must be asked
 * for), and it never nominates something it could not resolve. The scan/convert rules are the API's.
 */
type Handler = (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function harness() {
  const sent: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const handlers = new Map<string, Handler>();
  const detail = {
    id: 'db-1',
    fields: [
      { id: 'f-status', apiName: 'status', displayName: 'Status', type: 'select' },
      { id: 'f-title', apiName: 'name', displayName: 'Name', type: 'title' },
    ],
  };
  const log = (method: string) => async (path: string, o?: { body?: unknown }) => {
    sent.push({ method, path, body: o?.body as Record<string, unknown> });
    if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
    if (path === '/api/v1/workspaces/{ws}/databases') return { data: [{ id: 'db-1', name: 'Tasks', spaceSlug: 'work', apiSlug: 'tasks', qualifiedSlug: 'work/tasks' }] };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: detail };
    if (path === '/api/v1/workspaces/{ws}/workflow-nomination') return { data: { ok: true } };
    return { data: {} };
  };
  registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
    client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
    baseUrl: 'http://test',
    token: 'tok',
  });
  return { handlers, sent };
}

describe('#598 workflow nomination tools', () => {
  it('find_workflow_candidates reads the scan endpoint and sends nothing else', async () => {
    const { handlers, sent } = harness();
    const res = await handlers.get('find_workflow_candidates')!({ workspace: 'Eng' });
    expect(res.isError).toBeFalsy();
    expect(sent.find((s) => s.path === '/api/v1/workspaces/{ws}/workflow-nomination')!.method).toBe('GET');
    expect(sent.some((s) => s.method !== 'GET'), 'a scan is read-only').toBe(false);
  });

  it('nominate_workflows is a DRY RUN unless dry_run:false is passed, and resolves names to ids', async () => {
    const { handlers, sent } = harness();
    await handlers.get('nominate_workflows')!({ workspace: 'Eng', nominations: [{ database: 'Tasks', field: 'Status' }] });
    const body = sent.find((s) => s.method === 'POST')!.body!;
    expect(body.dry_run, 'the default must never convert').toBe(true);
    expect(body.nominations).toEqual([{ database_id: 'db-1', field_id: 'f-status' }]);

    sent.length = 0;
    await handlers.get('nominate_workflows')!({ workspace: 'Eng', nominations: [{ database: 'work/tasks', field: 'status' }], dry_run: false });
    expect(sent.find((s) => s.method === 'POST')!.body!.dry_run).toBe(false);
  });

  it('an unknown field or database is an error BEFORE anything is sent, naming what exists', async () => {
    const { handlers, sent } = harness();
    const bad = await handlers.get('nominate_workflows')!({ workspace: 'Eng', nominations: [{ database: 'Tasks', field: 'Nope' }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/No select field matches "Nope"/);
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
  });
});
