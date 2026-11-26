import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

/**
 * Ticket #704 - a field's description (its help text) over MCP.
 *
 * Driven through the handlers against a recording client, so the assertions are about what goes ON THE WIRE (the exact PATCH/POST body)
 * and what an agent READS BACK, not about intent. Two properties carry the whole feature and are easy to lose in a rewrite:
 *   - null CLEARS, so "was a description given?" is `!== undefined`, never a truthiness test;
 *   - an undescribed field adds no key to what an agent reads, so the common case stays terse and a copy-back cannot clear one by accident.
 */
const FIELD = '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}';
const FIELDS = '/api/v1/workspaces/{ws}/databases/{db}/fields';

interface Sent { method: string; path: string; body?: unknown }

function harness(fieldDescription?: string | null) {
  const sent: Sent[] = [];
  const db = {
    id: 'db-1',
    name: 'Projects',
    qualifiedSlug: 'general/projects',
    fields: [
      { id: 'f-goal', apiName: 'goal', displayName: 'Goal', type: 'text', description: fieldDescription },
      { id: 'f-plain', apiName: 'plain', displayName: 'Plain', type: 'text', description: null },
      { id: 'f-title', apiName: 'title', displayName: 'Title', type: 'title' },
    ],
  };
  const client = {
    GET: async (path: string) => {
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: [db] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: db };
      throw new Error(`unexpected GET ${path}`);
    },
    PATCH: async (path: string, opts: { body: unknown }) => {
      sent.push({ method: 'PATCH', path, body: opts.body });
      return { data: { ok: true } };
    },
    POST: async (path: string, opts: { body: unknown }) => {
      sent.push({ method: 'POST', path, body: opts.body });
      return { data: { id: 'f-new', apiName: 'new', displayName: 'New', type: 'text' } };
    },
  };
  const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const configs = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
  registerTools(
    { registerTool: (n: string, c: never, h: never) => { handlers.set(n, h as never); configs.set(n, c); } } as never,
    { client: client as never, baseUrl: 'http://t', token: 't' } as Ctx,
  );
  const call = async (tool: string, args: unknown) => {
    const res = await handlers.get(tool)!(args);
    if (res.isError) throw new Error(res.content[0]!.text);
    return JSON.parse(res.content[0]!.text) as never;
  };
  return { call, sent, configs };
}

type Described = { fields: Array<{ api_name: string; description?: unknown }> };

describe('describe_database (#704)', () => {
  it('returns a field description, and OMITS the key (not null, not empty) when there is none', async () => {
    const { call } = harness('What this project is meant to achieve.');
    const out = (await call('describe_database', { workspace: 'Eng', database: 'Projects' })) as Described;
    expect(out.fields.find((f) => f.api_name === 'goal')!.description).toBe('What this project is meant to achieve.');
    for (const name of ['plain', 'title']) {
      const f = out.fields.find((x) => x.api_name === name)!;
      expect('description' in f, `${name} has none, so no key`).toBe(false);
    }
  });

  it('a stored empty string is not echoed back as a description either', async () => {
    const { call } = harness('');
    const out = (await call('describe_database', { workspace: 'Eng', database: 'Projects' })) as Described;
    expect('description' in out.fields.find((f) => f.api_name === 'goal')!).toBe(false);
  });
});

describe('add_field (#704)', () => {
  it('sends the description it is given', async () => {
    const { call, sent } = harness();
    await call('add_field', { workspace: 'Eng', database: 'Projects', name: 'Budget', type: 'number', description: 'In euros.' });
    const post = sent.find((s) => s.path === FIELDS)!;
    expect((post.body as { description?: string }).description).toBe('In euros.');
  });

  it('sends NO description key when none is given (an absent description must not become a clear)', async () => {
    const { call, sent } = harness();
    await call('add_field', { workspace: 'Eng', database: 'Projects', name: 'Budget', type: 'number' });
    expect('description' in (sent.find((s) => s.path === FIELDS)!.body as object)).toBe(false);
  });

  it('forwards an explicit null (the caller said "none")', async () => {
    const { call, sent } = harness();
    await call('add_field', { workspace: 'Eng', database: 'Projects', name: 'Budget', type: 'number', description: null });
    expect((sent.find((s) => s.path === FIELDS)!.body as { description?: unknown }).description).toBeNull();
  });
});

describe('update_field (#704)', () => {
  const patches = (sent: Sent[]) => sent.filter((s) => s.method === 'PATCH' && s.path === FIELD);

  it('a description-only call sends exactly one PATCH carrying only the description', async () => {
    const { call, sent } = harness('old');
    await call('update_field', { workspace: 'Eng', database: 'Projects', field: 'goal', description: 'New words.' });
    expect(patches(sent).map((p) => p.body)).toEqual([{ description: 'New words.' }]);
  });

  it('null CLEARS: it is sent, not skipped as falsy', async () => {
    const { call, sent } = harness('old');
    await call('update_field', { workspace: 'Eng', database: 'Projects', field: 'goal', description: null });
    expect(patches(sent).map((p) => p.body)).toEqual([{ description: null }]);
  });

  it('an empty string is sent too (the API reads it as "none")', async () => {
    const { call, sent } = harness('old');
    await call('update_field', { workspace: 'Eng', database: 'Projects', field: 'goal', description: '' });
    expect(patches(sent).map((p) => p.body)).toEqual([{ description: '' }]);
  });

  it('a call that does not mention it sends no description (a rename must not touch the help text)', async () => {
    const { call, sent } = harness('old');
    await call('update_field', { workspace: 'Eng', database: 'Projects', field: 'goal', rename_to: 'Aim' });
    expect(patches(sent).map((p) => p.body)).toEqual([{ display_name: 'Aim' }]);
  });

  it('returns the field as the database now describes it', async () => {
    const { call } = harness('Original.');
    const out = (await call('update_field', { workspace: 'Eng', database: 'Projects', field: 'goal', description: 'Original.' })) as { description?: string };
    expect(out.description).toBe('Original.');
  });
});

describe('the tools say the parameter exists (#704)', () => {
  it('add_field and update_field list a `description` input, and the build_schema text names it', () => {
    const { configs } = harness();
    const inputs = (tool: string) => Object.keys((configs.get(tool)!.inputSchema as unknown as { shape: object }).shape);
    expect(inputs('add_field')).toContain('description');
    expect(inputs('update_field')).toContain('description');
    expect(configs.get('build_schema')!.description).toContain('description');
    expect(configs.get('describe_database')!.description).toContain('description');
  });
});
