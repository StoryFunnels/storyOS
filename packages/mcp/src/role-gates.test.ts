import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeToolMinRoles, renderGeneratedFile } from './role-gates.js';
import { TOOL_MIN_ROLE } from './role-gates.generated.js';
import { fetchHighestRole } from './client.js';
import { registerTools } from './tools.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * #1081 — tools/list shows only the tools the person's ROLE can use; a call to a hidden tool is still refused by the API.
 */
const REPO = join(import.meta.dirname, '..', '..', '..');
const openapi = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'openapi.json'), 'utf8'));
const toolsSource = readFileSync(join(import.meta.dirname, 'tools.ts'), 'utf8');

function advertised(effective: EffectiveScope): Set<string> {
  const names = new Set<string>();
  registerTools({ registerTool: (n: string) => names.add(n) } as never, { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx, effective);
  return names;
}
const FULL = { scope: 'admin', allowRunButton: true } as const;

describe('#1081 the role map is derived, not listed', () => {
  it('role-gates.generated.ts is current: run `pnpm sdk:generate` if this fails', () => {
    const expected = renderGeneratedFile(computeToolMinRoles(toolsSource, openapi));
    expect(readFileSync(join(import.meta.dirname, 'role-gates.generated.ts'), 'utf8')).toBe(expected);
  });

  it('computeToolMinRoles takes the HIGHEST role among a tool\'s routes, and leaves guest-level tools out', () => {
    const spec = { paths: { '/a': { get: {} }, '/b': { post: { 'x-min-role': 'member' } }, '/c': { delete: { 'x-min-role': 'admin' } } } };
    const src = [
      "  reg(\n    'reads',\n    {},\n    handle(async () => client.GET('/a'))",
      "  reg(\n    'writes',\n    {},\n    handle(async () => client.POST('/b'))",
      "  reg(\n    'mixed',\n    {},\n    handle(async () => { await client.POST('/b'); await client.DELETE('/c'); })",
    ].join('\n');
    expect(computeToolMinRoles(src, spec)).toEqual({ mixed: 'admin', writes: 'member' });
  });

  it('known cases: the audit log and grants need an admin, creating a database needs a member, a plain read needs nothing', () => {
    expect(TOOL_MIN_ROLE['list_audit_log']).toBe('admin');
    expect(TOOL_MIN_ROLE['list_grants']).toBe('admin');
    expect(TOOL_MIN_ROLE['create_database']).toBe('member');
    expect(TOOL_MIN_ROLE['list_workspaces']).toBeUndefined();
  });
});

describe('#1081 tools/list by role', () => {
  const admin = advertised({ ...FULL, role: 'admin' });
  const member = advertised({ ...FULL, role: 'member' });
  const guest = advertised({ ...FULL, role: 'guest' });
  const unknown = advertised(FULL);

  it('an admin sees everything; an unknown role (the /workspaces call failed) hides nothing', () => {
    expect(admin.size).toBeGreaterThan(150);
    expect(unknown).toEqual(admin);
  });

  it('a member loses exactly the admin-role tools, and keeps the member-level ones', () => {
    expect(member.has('list_audit_log')).toBe(false);
    expect(member.has('list_grants')).toBe(false);
    expect(member.has('create_database')).toBe(true);
    expect(member.has('query_records')).toBe(true);
    const hidden = [...admin].filter((n) => !member.has(n));
    expect(hidden.length).toBeGreaterThan(20);
    for (const n of hidden) expect(TOOL_MIN_ROLE[n], n).toBe('admin');
  });

  it('a guest also loses the member-level tools; everything a guest keeps needs no role', () => {
    expect(guest.has('create_database')).toBe(false);
    expect(guest.has('list_workspaces')).toBe(true);
    for (const n of guest) expect(TOOL_MIN_ROLE[n], n).toBeUndefined();
    expect(guest.size).toBeLessThan(member.size);
  });

  it('role and token scope compose: a read-scoped admin token still loses the writes', () => {
    const readAdmin = advertised({ scope: 'read', allowRunButton: false, role: 'admin' });
    expect(readAdmin.has('list_audit_log')).toBe(false); // scope ceiling
    expect(readAdmin.has('query_records')).toBe(true);
  });
});

describe('#1081 fetchHighestRole', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ctx = { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx;
  const stub = (res: unknown) => vi.stubGlobal('fetch', vi.fn(async () => res));

  it('is the highest role across the reachable workspaces', async () => {
    stub({ ok: true, json: async () => [{ role: 'guest' }, { role: 'member' }, { role: 'guest' }] });
    expect(await fetchHighestRole(ctx)).toBe('member');
    stub({ ok: true, json: async () => [{ role: 'member' }, { role: 'admin' }] });
    expect(await fetchHighestRole(ctx)).toBe('admin');
  });

  it('FAILS OPEN: an error, an empty list or an unknown shape says nothing, so no tool is hidden', async () => {
    stub({ ok: false, json: async () => [] });
    expect(await fetchHighestRole(ctx)).toBeUndefined();
    stub({ ok: true, json: async () => [] });
    expect(await fetchHighestRole(ctx)).toBeUndefined();
    stub({ ok: true, json: async () => [{ role: 'owner' }] });
    expect(await fetchHighestRole(ctx)).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await fetchHighestRole(ctx)).toBeUndefined();
  });
});
