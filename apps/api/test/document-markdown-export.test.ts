import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #262 phase 1 — server-side Markdown export of a standalone document.
 *
 * The load-bearing claim: this is a REAL BlockNote → Markdown conversion, not
 * a stub. `@blocknote/core`'s markdown export throws `ReferenceError: document
 * is not defined` in plain Node (verified directly before writing the fix) —
 * these tests exercise the actual HTTP route, so a regression that breaks the
 * jsdom polyfill fails here, not just in a unit test of the serializer alone.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let outsider: { token: string };
let wsId: string;
let spaceId: string;
let docId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'DocExportOwner');
  outsider = await signUpUser(app, 'DocExportOutsider');

  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'Doc Export WS' })).json().id;
  spaceId = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  const created = await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/${spaceId}/documents`, {
    title: 'Runbook: Incident Response',
  });
  docId = created.json().id;

  // BlockNote's real shape: `content` on a block is an ARRAY of inline nodes
  // ({ type: 'text', text: '...' }), never a bare string — confirmed against
  // @storyos/schemas/markdown's own text() helper after a bare string first
  // produced silently EMPTY headings/paragraphs (a real gap in this test, not
  // in the production code: it typechecks as `unknown`, so nothing caught it).
  const t = (s: string) => [{ type: 'text' as const, text: s, styles: {} }];

  // A freshly created document starts at version 1, not 0 — verified directly
  // rather than assumed. Reading it back off the create response instead of
  // hardcoding it, so this doesn't silently rot if that default ever changes.
  await as(owner.token, 'PATCH', `/workspaces/${wsId}/documents/${docId}`, {
    expected_version: created.json().version,
    content: [
      { type: 'heading', props: { level: 2 }, content: t('Step 1') },
      { type: 'paragraph', content: t('Page the on-call engineer.') },
      { type: 'bulletListItem', content: t('Check the status page') },
      { type: 'bulletListItem', content: t('Post in #incidents') },
    ],
  });
});

afterAll(async () => {
  await app.close();
});

describe('GET .../documents/:doc/export/markdown (#262)', () => {
  it('renders real BlockNote content to Markdown, prefixed with the title as an H1', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/documents/${docId}/export/markdown`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('# Runbook: Incident Response');
    expect(res.body).toContain('## Step 1');
    expect(res.body).toContain('Page the on-call engineer.');
    expect(res.body).toContain('- Check the status page');
    expect(res.body).toContain('- Post in #incidents');
  });

  it('sets a slugified filename on content-disposition, matching export/csv.ts\'s own slug convention (case preserved)', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/documents/${docId}/export/markdown`);
    expect(res.headers['content-disposition']).toContain('Runbook-Incident-Response.md');
  });

  it('exports an EMPTY document as just its title, not an error', async () => {
    const empty = await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/${spaceId}/documents`, {
      title: 'Untouched draft',
    });
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/documents/${empty.json().id}/export/markdown`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body.trim()).toBe('# Untouched draft');
  });

  it('refuses someone with no access to the workspace — 404, not 403, matching the guard\'s own no-existence-leak convention (WorkspaceAccessGuard)', async () => {
    const res = await as(outsider.token, 'GET', `/workspaces/${wsId}/documents/${docId}/export/markdown`);
    expect(res.statusCode).toBe(404);
  });

  it('is idempotent — exporting twice in a row returns byte-identical output', async () => {
    const first = await as(owner.token, 'GET', `/workspaces/${wsId}/documents/${docId}/export/markdown`);
    const second = await as(owner.token, 'GET', `/workspaces/${wsId}/documents/${docId}/export/markdown`);
    expect(first.body).toEqual(second.body);
  });
});
