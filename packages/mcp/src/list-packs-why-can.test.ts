import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';

/**
 * Ticket #1145 — `list_packs` is a straight proxy of GET /packs/registry, so apps/api/test/pack-why-can.test.ts is what proves
 * the listing carries why/can/relations. What THIS pins is the MCP's side of the promise: it hands the listing through whole
 * (a future "tidy the output" that picks fields would silently drop them), and its description tells an agent the fields exist.
 * It does NOT prove the live API shape; the stub below is the API test's job to keep honest.
 */
const card = {
  slug: 'deal-desk',
  name: 'Deal Desk',
  why: 'You sell to companies and deals go quiet.',
  can: ['Drag every deal through one board', 'See which deals are drifting', 'Draft the follow-up'],
  relations: [{ from: 'Deals', to: 'Companies', cardinality: 'one_to_many', from_field: 'Company', to_field: 'Deals' }],
};

function setup() {
  const configs = new Map<string, { description?: string }>();
  const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const client = {
    GET: async (path: string) => (path === '/api/v1/packs/registry' ? { data: [card] } : { error: { message: `unexpected ${path}` } }),
  };
  registerTools(
    {
      registerTool: (n: string, c: never, h: never) => {
        configs.set(n, c);
        handlers.set(n, h as never);
      },
    } as never,
    { client: client as never, baseUrl: 'http://test', token: 'tok' } as never,
  );
  return { configs, handlers };
}

describe('list_packs (#1145)', () => {
  it('returns why, can and relations for each pack, unmodified', async () => {
    const { handlers } = setup();
    const res = await handlers.get('list_packs')!({});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual([card]);
  });

  it('its description names the three fields', () => {
    const d = setup().configs.get('list_packs')!.description!;
    for (const word of ['why', 'can', 'relations']) expect(d, word).toContain(`\`${word}\``);
  });
});
