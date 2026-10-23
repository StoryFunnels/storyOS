import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

/**
 * Ticket #1032 — the MCP tools set a public form's redirect_url too (create_view / update_view), through their own input schema. A
 * `javascript:` or `data:` value must be refused HERE, before any request is made, as well as by the API.
 */
function schemasOf(tool: string): Record<string, z.ZodType> {
  let found: unknown;
  const server = {
    registerTool: (name: string, config: { inputSchema?: unknown }) => {
      if (name === tool) found = config.inputSchema;
    },
  };
  registerTools(server as never, { client: {}, baseUrl: 'http://api.test', token: 't' } as unknown as Ctx);
  if (!found) throw new Error(`tool ${tool} not registered`);
  // `reg` hands the server a z.object, not the raw shape the tool was declared with.
  return (found as { shape?: Record<string, z.ZodType> }).shape ?? (found as Record<string, z.ZodType>);
}

const ATTACKS = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'javascript://%0aalert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)'];

describe.each(['create_view', 'update_view'])('%s — form_redirect_url (ticket #1032)', (tool) => {
  const field = () => schemasOf(tool)['form_redirect_url']!;
  it.each(ATTACKS)('refuses %j', (value) => {
    expect(field().safeParse(value).success).toBe(false);
  });
  it('accepts a real https address and an absent one', () => {
    expect(field().safeParse('https://example.com/thanks').success).toBe(true);
    expect(field().safeParse(undefined).success).toBe(true);
  });
});
