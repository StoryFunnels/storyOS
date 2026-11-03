import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerTools } from './tools.js';
import { createRequestListener, resolveConfig } from './http.js';
import { AGENT_RUN_BASE_TOOLS, AGENT_RUN_PROFILE, resolveToolProfile } from './tool-profiles.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * #1177 — an agent run is offered a short tool list. Every test here enumerates the LIVE registry (registerTools against a recording
 * server), never a hand-copied list: a fixture that is a prefix of reality passes for exactly the cases it omits.
 */
function advertised(effective: EffectiveScope): Set<string> {
  const names = new Set<string>();
  registerTools({ registerTool: (n: string) => names.add(n) } as never, { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx, effective);
  return names;
}
const FULL: EffectiveScope = { scope: 'admin', allowRunButton: true };
/** What a run credential looks like to the server: write scope (never admin), a member role. */
const RUN_CRED: EffectiveScope = { scope: 'write', allowRunButton: false, role: 'member' };
const profile = (qs: string) => {
  const r = resolveToolProfile(new URLSearchParams(qs));
  if (!r.ok) throw new Error(r.error);
  return r.allow;
};

describe('a person keeps the full tool set', () => {
  it('no profile = no filter: the same set as before this ticket, for a human with any scope', () => {
    const r = resolveToolProfile(new URLSearchParams(''));
    expect(r).toEqual({ ok: true, allow: undefined });
    const all = advertised(FULL);
    expect(all.size).toBeGreaterThan(150);
    // the whole write-scoped set a run credential would see WITHOUT the profile is still large (this is the cost being removed)
    expect(advertised(RUN_CRED).size).toBeGreaterThan(100);
  });
});

describe('the agent-run profile', () => {
  const allow = profile(`profile=${AGENT_RUN_PROFILE}`)!;

  it('EVERY name in the profile exists in the live registry (a typo or a renamed tool fails here, not silently in production)', () => {
    const live = advertised(FULL);
    for (const name of AGENT_RUN_BASE_TOOLS) expect(live.has(name), `${name} is not a registered tool`).toBe(true);
  });

  it('offers a write-scoped run credential exactly the base set and nothing else', () => {
    const offered = advertised({ ...RUN_CRED, onlyTools: allow });
    expect([...offered].sort()).toEqual([...AGENT_RUN_BASE_TOOLS].sort());
  });

  it('NEW-TOOL DEFAULT: a tool that is not named in the profile is not offered, whatever the registry grows', () => {
    const all = advertised(FULL);
    const offeredToAnAdminCredential = advertised({ ...FULL, onlyTools: allow });
    // the registry has 150+ tools, the profile is the intersection with its own list: adding a tool changes neither side of this
    expect(offeredToAnAdminCredential.size).toBeLessThanOrEqual(AGENT_RUN_BASE_TOOLS.length);
    for (const n of all) if (!(AGENT_RUN_BASE_TOOLS as readonly string[]).includes(n)) expect(offeredToAnAdminCredential.has(n), n).toBe(false);
  });

  it('keeps the definitions small: the profile is under a tenth of the full set (the measured saving, not just a count)', () => {
    expect(AGENT_RUN_BASE_TOOLS.length).toBeLessThan(advertised(RUN_CRED).size / 10);
  });

  it('does not widen scope: a read-scoped credential still gets no writes, and an offered tool still needs its scope', () => {
    const read = advertised({ scope: 'read', allowRunButton: false, role: 'member', onlyTools: allow });
    expect(read.has('get_record')).toBe(true);
    expect(read.has('update_record')).toBe(false);
    expect(read.has('add_comment')).toBe(false);
  });

  it('tools outside the role are not offered: delete, schema, members, webhooks, run_button', () => {
    const offered = advertised({ ...RUN_CRED, onlyTools: allow });
    const live = advertised(RUN_CRED);
    const outside = ['delete_record', 'delete_database', 'create_database', 'list_members', 'list_runners', 'create_automation', 'create_record', 'link_records'].filter((n) => live.has(n));
    // without profile these ARE offered to the same credential: the check means something only for names that really exist
    expect(outside.length).toBeGreaterThanOrEqual(5);
    for (const n of outside) expect(offered.has(n), n).toBe(false);
  });
});

describe('a role can add tools', () => {
  it('extras are added to the base set and are offered, within the credential\'s own scope', () => {
    const allow = profile(`profile=${AGENT_RUN_PROFILE}&tools=create_record,link_records`)!;
    const offered = advertised({ ...RUN_CRED, onlyTools: allow });
    expect(offered.has('create_record')).toBe(true);
    expect(offered.has('link_records')).toBe(true);
    expect(offered.has('get_record')).toBe(true);
    expect(offered.size).toBe(AGENT_RUN_BASE_TOOLS.length + 2);
    // an extra above the credential's scope or role is still not offered: the profile narrows, it never grants
    const adminOnly = advertised({ ...RUN_CRED, onlyTools: profile(`profile=${AGENT_RUN_PROFILE}&tools=list_audit_log`)! });
    expect(adminOnly.has('list_audit_log')).toBe(false);
  });

  it('an extra that is not a tool is harmless (offers nothing extra) and one that is not even a name is an error', () => {
    const offered = advertised({ ...RUN_CRED, onlyTools: profile(`profile=${AGENT_RUN_PROFILE}&tools=no_such_tool`)! });
    expect(offered.size).toBe(AGENT_RUN_BASE_TOOLS.length);
    expect(resolveToolProfile(new URLSearchParams(`profile=${AGENT_RUN_PROFILE}&tools=a/b`)).ok).toBe(false);
  });
});

describe('a mistake never silently turns the diet off', () => {
  it('an unknown profile and tools= without a profile are errors, not the full set', () => {
    const unknown = resolveToolProfile(new URLSearchParams('profile=agent_run'));
    expect(unknown.ok).toBe(false);
    expect(resolveToolProfile(new URLSearchParams('tools=create_record')).ok).toBe(false);
  });
});

describe('the HTTP endpoint', () => {
  function call(url: string) {
    const captured: { status?: number; body?: string } = {};
    const res = {
      headersSent: false,
      setHeader() {},
      writeHead(s: number) { captured.status = s; return this; },
      end(b?: string) { captured.body = b; },
      on() { return this; },
    } as unknown as ServerResponse;
    const req = { method: 'POST', url, headers: { authorization: 'Bearer t' }, on: () => undefined } as unknown as IncomingMessage;
    return createRequestListener(resolveConfig({}))(req, res).then(() => captured);
  }

  it('answers 400 for an unknown profile before touching the API', async () => {
    const out = await call('/mcp?profile=everything');
    expect(out.status).toBe(400);
    expect(out.body).toContain('unknown tool profile');
  });
});
