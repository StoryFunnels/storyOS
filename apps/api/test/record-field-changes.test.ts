import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
// #390 — the agent/automation legs are driven through the REAL shared executor
// rather than asserted by reading the call site.
import { AutomationActionsService } from '../src/automations/actions.service';
import { RecordsService } from '../src/records/records.service';
import { TokensService } from '../src/tokens/tokens.service';

/**
 * #31 (version history C2) — field-level change capture and the per-record
 * timeline it feeds.
 *
 * `record_versions` (MN-231) already answered "what did this look like then".
 * These assert the question this ticket adds: "who changed WHICH FIELD, and
 * from what".
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let statusApi: string;
let statusId: string;
let actionsService: AutomationActionsService;
let recordsService: RecordsService;
let tokensService: TokensService;
let adminUserId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function createRecord(values: Record<string, unknown>) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values });
  expect(res.statusCode, JSON.stringify(res.json())).toBeLessThan(300);
  return res.json() as { id: string };
}

async function changesFor(recordId: string) {
  const res = await as(
    admin.token,
    'GET',
    `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/versions/changes`,
  );
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  return res.json() as {
    data: Array<{
      field_id: string | null;
      field_name: string;
      field_type?: string | null;
      new_display?: unknown;
      source: string;
      old_value: unknown;
      new_value: unknown;
      actor_id: string | null;
    }>;
    has_more: boolean;
    next_cursor: string | null;
  };
}

beforeAll(async () => {
  app = await createTestApp();
  // `strict: false` — these providers live in feature modules, not the root, so
  // the default strict lookup cannot see them.
  actionsService = app.get(AutomationActionsService, { strict: false });
  tokensService = app.get(TokensService, { strict: false });
  recordsService = app.get(RecordsService, { strict: false });
  admin = await signUpUser(app, 'field-history');
  adminUserId = (await as(admin.token, 'GET', '/me')).json().id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'History Co' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })
  ).json().id;
  const field = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Status',
      type: 'text',
    })
  ).json();
  statusApi = field.apiName;
  statusId = field.id;
});

afterAll(async () => {
  await app?.close();
});

describe('field-level capture (#31)', () => {
  it('records one event per changed field, with old and new values', async () => {
    const rec = await createRecord({ name: 'Ship it', [statusApi]: 'todo' });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [statusApi]: 'doing' },
    });

    const { data } = await changesFor(rec.id);
    const status = data.find((c) => c.field_id === statusId);
    expect(status, 'a change event for the edited field').toBeTruthy();
    expect(status!.old_value).toBe('todo');
    expect(status!.new_value).toBe('doing');
    expect(status!.field_name).toBe('Status');
    // Attribution: a session write is a human, and the actor is the editor.
    expect(status!.source).toBe('human');
    expect(status!.actor_id).toBeTruthy();
  });

  it('captures a title edit under the promoted title column, not a field id', async () => {
    const rec = await createRecord({ name: 'Before' });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'After' },
    });

    const { data } = await changesFor(rec.id);
    // record-diff.ts denotes the title with the literal "title"; the table
    // stores that as a null field_id, and the API renders it as "Name".
    const title = data.find((c) => c.field_id === null);
    expect(title, 'a change event for the title').toBeTruthy();
    expect(title!.old_value).toBe('Before');
    expect(title!.new_value).toBe('After');
    expect(title!.field_name).toBe('Name');
  });

  it('suppresses no-ops — writing the same value captures nothing', async () => {
    const rec = await createRecord({ name: 'Same', [statusApi]: 'todo' });
    const before = (await changesFor(rec.id)).data.length;

    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [statusApi]: 'todo' },
    });

    // A write that changed nothing is not history. Capturing it would bury the
    // real edits in noise on any record touched by an automation.
    expect((await changesFor(rec.id)).data.length).toBe(before);
  });

  it('one edit of two fields produces two events, not one', async () => {
    const rec = await createRecord({ name: 'Two', [statusApi]: 'a' });
    const before = (await changesFor(rec.id)).data.length;

    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'Two changed', [statusApi]: 'b' },
    });

    // Field granularity IS the product — a single row saying "the record
    // changed" is what record_versions already does.
    expect((await changesFor(rec.id)).data.length).toBe(before + 2);
  });
});

describe('the timeline reads back (#31)', () => {
  it('returns newest first and pages with a cursor', async () => {
    const rec = await createRecord({ name: 'Paged', [statusApi]: '0' });
    for (const v of ['1', '2', '3']) {
      await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
        values: { [statusApi]: v },
      });
    }

    const first = await as(
      admin.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions/changes?limit=2`,
    );
    const page = first.json() as { data: Array<{ new_value: unknown }>; has_more: boolean; next_cursor: string | null };
    expect(page.data).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBeTruthy();

    // Newest first — and asserted against what the record ACTUALLY holds now,
    // not against the literal we sent. The API coerces some values on write
    // (a text field given "3" reads back as 3), and the invariant that matters
    // is that history agrees with reality, not that it echoes the request.
    const current = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)
    ).json() as { values: Record<string, unknown> };
    /*
     * Compared as strings, deliberately. Capture stores what the WRITE stored;
     * the record read path coerces a text field's value on the way out, so a
     * text field holding 3 reads back as "3" while history holds 3. History is
     * faithful to storage — the two representations differ, and reconciling
     * them belongs to the timeline UI (#335), not to this assertion.
     */
    expect(String(page.data[0]!.new_value)).toBe(String(current.values[statusApi]));

    const second = await as(
      admin.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions/changes?limit=2&cursor=${page.next_cursor}`,
    );
    const rest = second.json() as { data: Array<{ new_value: unknown }> };
    // The cursor must not re-serve what page one already returned.
    expect(rest.data.map((c) => String(c.new_value))).not.toContain(String(current.values[statusApi]));
  });

  it('a deleted field keeps its history, rendered readably', async () => {
    const doomed = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Temporary',
        type: 'text',
      })
    ).json();
    const rec = await createRecord({ name: 'Outlives', [doomed.apiName]: 'first' });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [doomed.apiName]: 'second' },
    });
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${doomed.id}`);

    // "Who emptied this" must survive the field being removed — that is exactly
    // when someone asks. A bare uuid here would be useless.
    const { data } = await changesFor(rec.id);
    const event = data.find((c) => c.field_id === doomed.id);
    expect(event).toBeTruthy();
    /*
     * #335 — this assertion CHANGED, deliberately.
     *
     * It used to expect the bare 'Temporary'. The activity feed, reading a diff
     * written by the same update(), had always returned 'Temporary (deleted
     * field)'. Two sibling endpoints describing the same change two different
     * ways is the defect this ticket is about, so they now share one resolver
     * and the marker wins: it keeps the name AND tells the reader the field is
     * gone, which is the thing they are usually trying to find out.
     */
    expect(event!.field_name).toBe('Temporary (deleted field)');
    // The name half still has to be there — a marker that ate the name would be
    // a regression dressed up as a fix.
    expect(event!.field_name).toContain('Temporary');
    // And the value renders, rather than coming back as a bare id (#335's point).
    expect(event!.new_display).toBe('second');
    expect(event!.field_type).toBe('text');
  });
});

/**
 * #390 — the `source` axis: WHAT made the change, beside WHO it was for.
 *
 * The column, the enum and the read path have existed since #31. Nothing ever
 * wrote a non-default value, so every row in the product said 'human' —
 * including rows written by automations and by MCP. The badge was decorative:
 * it rendered whatever the default said.
 *
 * Two Tyron tickets were already relying on this as if it were finished (#357
 * lists "`source` is set to the agent value" as an acceptance criterion; #364
 * narrowed its own scope on the strength of it), and both read as one-line
 * checks. Neither was: there was no code path that accepted a source, so "don't
 * skip setting it" could not be complied with.
 */
describe('#390 — what made the change, not just who it was for', () => {
  it('an ordinary UI write is human — the REGRESSION half', async () => {
    /*
     * Asserted first and deliberately. Without it, a later refactor that
     * defaulted everything to 'agent' would pass every other test in this
     * block while silently mislabelling the overwhelming majority of writes.
     */
    const rec = await createRecord({ name: 'Typed by a person' });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'Edited by a person' },
    });
    const { data } = await changesFor(rec.id);
    expect(data[0]!.source).toBe('human');
  });

  it('a write through a personal access token lands as mcp', async () => {
    // A PAT is how MCP arrives (`auth.via === 'token'`). Proven by writing
    // through one, not by reading the controller.
    const pat = await as(admin.token, 'POST', '/me/tokens', {
      name: 'MCP test',
      workspace_id: wsId,
      scope: 'admin',
    });
    expect(pat.statusCode, JSON.stringify(pat.json())).toBeLessThan(300);
    const token = (pat.json() as { token: string }).token;

    const rec = await createRecord({ name: 'Written by a program' });
    const res = await as(token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'Edited over MCP' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBeLessThan(300);

    const { data } = await changesFor(rec.id);
    expect(data[0]!.source).toBe('mcp');
  });

  it("#357 — TYRON's own token writes as agent, not mcp", async () => {
    /*
     * The gap #390 could not close.
     *
     * #390 derived the source from HOW a request authenticated: session means a
     * person, token means a program. Correct as far as it goes — but Tyron mints
     * an ordinary personal access token (ADR-0016 §2), so its writes arrived
     * looking exactly like a curl script's. #357 requires "a person did this"
     * and "an agent generated it" to BOTH be recoverable, and the second one
     * was not.
     *
     * The provenance is on the token ROW, not a header: a header is forgeable by
     * whoever holds the token, and provenance that can be claimed is not
     * provenance. So this test mints the way Tyron mints and proves the badge
     * follows the token rather than the caller's say-so.
     */
    const minted = await tokensService.create(adminUserId, wsId, 'Tyron (session)', 'admin', true, 'agent');

    const rec = await createRecord({ name: 'Asked of Tyron' });
    const res = await as(minted.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'Changed by Tyron' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBeLessThan(300);

    const { data } = await changesFor(rec.id);
    expect(data[0]!.source).toBe('agent');
    // NOT mcp — that is the whole distinction this ticket adds.
    expect(data[0]!.source).not.toBe('mcp');
    // And the actor is still the PERSON who asked. Founder, verbatim: "it's
    // always a person that run the AI agent, never the agent himself."
    expect(data[0]!.actor_id).toBe(adminUserId);
  });

  it('an ordinary PAT is unchanged by #357 — no origin means mcp', async () => {
    /*
     * The regression half. Every token that already exists has a null origin,
     * and must keep behaving exactly as it did. A migration that defaulted them
     * to 'agent' would relabel every script in every workspace.
     */
    const plain = await tokensService.create(adminUserId, wsId, 'Ordinary PAT', 'admin');
    const rec = await createRecord({ name: 'Script wrote this' });
    await as(plain.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'Edited by a script' },
    });
    const { data } = await changesFor(rec.id);
    expect(data[0]!.source).toBe('mcp');
  });

  it('an AGENT write lands as agent — and the actor is STILL the person', async () => {
    /*
     * The pair is the point, which is why both halves are asserted on the SAME
     * row. Attribution stays the person in every case (ADR-0010 §2, and #357's
     * founder decision: "it's always a person that ran the AI agent, never the
     * agent himself"). A change that set `actorUserId` to an agent id would
     * satisfy a naive reading of "distinguish agent writes" and quietly destroy
     * the accountability trail — that is the wrong turn this guards against.
     *
     * Driven through ActionsService.execute, which is the REAL path: an agent
     * applying a staged action calls straight into this executor
     * (AgentsService.applyProposedAction). It is shared with automations, so
     * hardcoding a source inside it would have stamped every agent write
     * 'automation'.
     */
    const rec = await createRecord({ name: 'Touched by an agent' });
    const record = await recordsService.get(dbId, rec.id);
    await actionsService.execute(
      [{ type: 'set_values', values: { name: 'Generated' } } as never],
      { workspaceId: wsId, databaseId: dbId, record, actorId: adminUserId, source: 'agent' } as never,
    );

    const { data } = await changesFor(rec.id);
    expect(data[0]!.source).toBe('agent');
    expect(data[0]!.actor_id, 'the PERSON stays the actor — source is a second axis').toBe(adminUserId);
  });

  it('the same executor defaults to automation when no source is given', async () => {
    // Every pre-existing caller is a rule, so the default must be 'automation'
    // rather than 'human' — otherwise threading it would have been a no-op for
    // exactly the case that was already wrong.
    const rec = await createRecord({ name: 'Touched by a rule' });
    const record = await recordsService.get(dbId, rec.id);
    await actionsService.execute(
      [{ type: 'set_values', values: { name: 'Set by rule' } } as never],
      { workspaceId: wsId, databaseId: dbId, record, actorId: adminUserId } as never,
    );

    const { data } = await changesFor(rec.id);
    expect(data[0]!.source).toBe('automation');
  });
});
