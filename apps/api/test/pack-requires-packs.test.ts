import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Ticket #1197 - a manifest says which pack it builds on (`requires.packs`): the required pack's databases are LINKED when it is installed,
 * the review offers `also_install` / `create_here` when it is not, each works, and uninstalling the dependent pack never touches the other.
 * The required pack is the real built-in Agency OS; the dependent one is a fixture (Deal Desk).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;

const dealDesk = (over: Record<string, unknown> = {}) => ({
  format_version: 1,
  slug: 'deal-desk',
  name: 'Deal Desk',
  version: '1.0.0',
  summary: 'Deals that hang off Agency OS clients',
  requires: { connections: [], ai: 'none', packs: [{ pack: 'agency-os', databases: ['Clients'], note: 'Deals belong to your agency clients.' }] },
  databases: [
    { action: 'create', name: 'Clients', space: 'Deal Desk', fields: [{ name: 'Website', type: 'url' }, { name: 'Deal Value', type: 'number' }] },
    { action: 'create', name: 'Deals', space: 'Deal Desk', fields: [{ name: 'Amount', type: 'number' }] },
  ],
  relations: [{ from: 'Deals', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Deals' }],
  ...over,
});
const agencyOs = async () => (await as('GET', '/packs/registry/agency-os')).json().manifest;
const preview = (ws: string, body: Record<string, unknown> = {}, manifest = dealDesk()) => as('POST', `/workspaces/${ws}/packs/preview`, { manifest, ...body });
const install = (ws: string, body: Record<string, unknown> = {}, manifest = dealDesk()) => as('POST', `/workspaces/${ws}/packs/install`, { manifest, ...body });
const dbs = async (ws: string) => (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string }>;
const installed = async (ws: string) => (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
const fieldNames = async (ws: string, id: string) => ((await as('GET', `/workspaces/${ws}/databases/${id}`)).json().fields as Array<{ displayName: string }>).map((f) => f.displayName);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Requires Packs');
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe('the required pack IS installed (#1197)', () => {
  it('preview says so and lists the fields this pack adds; install links to its Clients instead of creating one', async () => {
    const ws = await newWs('Linked');
    expect((await install(ws, {}, await agencyOs())).statusCode).toBe(201);
    const agencyClients = (await dbs(ws)).filter((d) => d.name === 'Clients');
    expect(agencyClients).toHaveLength(1);

    const pv = (await preview(ws)).json();
    expect(pv.required_packs).toEqual([
      {
        pack: 'agency-os', name: 'Agency OS', note: 'Deals belong to your agency clients.', databases: ['Clients'], installed: true, linked: ['Clients'],
        fields_added: expect.arrayContaining([{ database: 'Clients', name: 'Deal Value', type: 'number' }]), choices: ['create_here'],
      },
    ]);
    expect(pv.required_packs[0].chosen, 'the link stands: nothing chosen').toBeUndefined();

    const res = await install(ws);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().required_packs).toEqual([{ pack: 'agency-os', outcome: 'linked', databases: ['Clients'] }]);
    const clients = (await dbs(ws)).filter((d) => d.name === 'Clients');
    expect(clients.map((d) => d.id), 'still the one Agency OS Clients').toEqual([agencyClients[0]!.id]);
    expect(await fieldNames(ws, clients[0]!.id)).toContain('Deal Value');
    expect(await fieldNames(ws, (await dbs(ws)).find((d) => d.name === 'Deals')!.id)).toContain('Client');
  });

  it('create_here declines the link: the pack makes its own Clients', async () => {
    const ws = await newWs('Decline');
    await install(ws, {}, await agencyOs());
    const res = await install(ws, { required_packs: { 'agency-os': 'create_here' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().required_packs[0].outcome).toBe('created_here');
    expect((await dbs(ws)).filter((d) => d.name === 'Clients')).toHaveLength(2);
  });

  it('with another same-named database, the #1176 pick wins over the required pack\'s', async () => {
    const ws = await newWs('Picker');
    await install(ws, {}, await agencyOs());
    const space = (await as('POST', `/workspaces/${ws}/spaces`, { name: 'Mine' })).json().id as string;
    const mine = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Clients' })).json().id as string;
    const res = await install(ws, { resolutions: { Clients: { action: 'reuse', database_id: mine } } });
    expect(res.statusCode, res.body).toBe(201);
    expect(await fieldNames(ws, mine)).toContain('Deal Value');
  });

  it('uninstalling the dependent pack leaves the required pack, its databases and its views intact', async () => {
    const ws = await newWs('Uninstall');
    await install(ws, {}, await agencyOs());
    const before = (await dbs(ws)).map((d) => d.id).sort();
    const viewsOf = async (id: string) => ((await as('GET', `/workspaces/${ws}/databases/${id}/views`)).json() as unknown[]).length;
    const agencyClientsId = (await dbs(ws)).find((d) => d.name === 'Clients')!.id;
    const viewsBefore = await viewsOf(agencyClientsId);
    await install(ws);
    const dd = (await installed(ws)).find((i) => i.slug === 'deal-desk')!;
    expect((await as('POST', `/workspaces/${ws}/packs/${dd.id}/uninstall`, {})).statusCode).toBe(201);
    const after = (await dbs(ws)).map((d) => d.id);
    for (const id of before) expect(after, 'every Agency OS database survives').toContain(id);
    expect(await viewsOf(agencyClientsId)).toBe(viewsBefore);
    expect((await installed(ws)).map((i) => i.slug)).toContain('agency-os');
    expect((await installed(ws)).map((i) => i.slug)).not.toContain('deal-desk');
  });
});

describe('the required pack is NOT installed (#1197)', () => {
  it('preview offers both choices, defaults to create_here and names no field it cannot know', async () => {
    const ws = await newWs('Offer');
    const rp = (await preview(ws)).json().required_packs[0];
    expect(rp).toMatchObject({ pack: 'agency-os', name: 'Agency OS', installed: false, linked: [], fields_added: [], choices: ['also_install', 'create_here'], chosen: 'create_here' });
    expect((await preview(ws, { required_packs: { 'agency-os': 'also_install' } })).json().required_packs[0].chosen).toBe('also_install');
  });

  it('create_here (and no answer at all): the linked databases are made inside this pack, and nothing else is installed', async () => {
    const ws = await newWs('Here');
    const res = await install(ws, { required_packs: { 'agency-os': 'create_here' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().required_packs).toEqual([{ pack: 'agency-os', outcome: 'created_here', databases: ['Clients'] }]);
    const clients = (await dbs(ws)).filter((d) => d.name === 'Clients');
    expect(clients).toHaveLength(1);
    expect(await fieldNames(ws, clients[0]!.id)).toContain('Deal Value');
    expect((await installed(ws)).map((i) => i.slug)).toEqual(['deal-desk']);
    const again = await install(await newWs('Default'));
    expect(again.json().required_packs[0].outcome).toBe('created_here');
  });

  it('also_install: Agency OS is installed first and Deal Desk links to its Clients (one Clients, not two)', async () => {
    const ws = await newWs('Also');
    const res = await install(ws, { required_packs: { 'agency-os': 'also_install' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().required_packs).toEqual([{ pack: 'agency-os', outcome: 'installed_and_linked', databases: ['Clients'] }]);
    expect((await installed(ws)).map((i) => i.slug).sort()).toEqual(['agency-os', 'deal-desk']);
    const clients = (await dbs(ws)).filter((d) => d.name === 'Clients');
    expect(clients).toHaveLength(1);
    expect(await fieldNames(ws, clients[0]!.id)).toEqual(expect.arrayContaining(['Industry', 'Deal Value']));
  });

  it('also_install for a pack StoryOS does not ship is refused with a way out, and nothing is created', async () => {
    const ws = await newWs('Unknown');
    const m = dealDesk({ requires: { connections: [], ai: 'none', packs: [{ pack: 'no-such-pack', databases: ['Clients'] }] } });
    const rp = (await preview(ws, {}, m)).json().required_packs[0];
    expect(rp.choices).toEqual(['create_here']);
    const res = await install(ws, { required_packs: { 'no-such-pack': 'also_install' } }, m);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/create_here/);
    expect((await dbs(ws)).filter((d) => ['Clients', 'Deals'].includes(d.name))).toHaveLength(0);
  });
});

describe('refusals (#1197)', () => {
  it('a choice for a pack the manifest does not require is a 422', async () => {
    const res = await install(await newWs('Stray choice'), { required_packs: { 'client-portal': 'also_install' } });
    expect(res.statusCode).toBe(422);
  });
  it('requires.packs naming a database the manifest does not have is a 422', async () => {
    const m = dealDesk({ requires: { connections: [], ai: 'none', packs: [{ pack: 'agency-os', databases: ['Projects'] }] } });
    const res = await install(await newWs('Stray db'), {}, m);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/no database of that name/);
  });
  it('a pack cannot require itself', async () => {
    const m = dealDesk({ requires: { connections: [], ai: 'none', packs: [{ pack: 'deal-desk', databases: ['Clients'] }] } });
    expect((await install(await newWs('Self'), {}, m)).statusCode).toBe(422);
  });
});
