import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

// #500 — a dedicated app instance (and so a dedicated throttle bucket) rather
// than adding this block to forms.test.ts: the public submit route is
// hardcoded to 10/min (public-forms.controller.ts), and forms.test.ts's own
// pre-existing submits already sit close to that budget. A second file means
// this feature's coverage never has to fight the sibling ticket's for room.
let app: NestFastifyApplication;
let token: string;
let wsId: string;
let dbId: string;
let nameFieldId: string;
let msgFieldId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
/** Unauthenticated request (no headers) — the public form path. */
async function pub(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'CondReqOwner')).token;
  wsId = (await as('POST', '/workspaces', { name: 'CondReq WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
  const dbFields = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().fields as Array<{ id: string; type: string; api_name: string }>;
  nameFieldId = dbFields.find((f) => f.type === 'title' || f.api_name === 'name')!.id;
  msgFieldId = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Message', type: 'text' })).json().id;
});
afterAll(async () => {
  await app.close();
});

/**
 * #500 — conditional required. Same rule shape/evaluator as #263's visibility
 * (form-visibility.ts), gating `required` instead of presence: a field stays
 * on the form (and possibly visible) but is only REQUIRED once its own
 * condition holds. The server half is the load-bearing one, same as #263 —
 * a required-looking field the client never enforces is a courtesy; refusing
 * the record on submit is the gate.
 */
describe('#500 conditional required', () => {
  /** name (title) -> message, required only when name is exactly "must-answer". */
  async function makeConditionalRequiredForm(tok: string) {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: `CondReq ${tok}`,
      type: 'form',
      config: {
        sorts: [],
        hidden_field_ids: [],
        card_field_ids: [],
        column_widths: {},
        form: {
          title: 'Conditional required',
          access: 'public',
          public_token: tok,
          fields: [
            { field_id: nameFieldId, label: 'Your name' },
            {
              field_id: msgFieldId,
              required: true,
              required_when: { field_id: nameFieldId, op: 'eq', value: 'must-answer' },
            },
          ],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  }

  it('serves the rule keyed by api_name, never by internal field id', async () => {
    await makeConditionalRequiredForm('tok-condreq');
    const def = (await pub('GET', '/public/forms/tok-condreq')).json();
    const message = def.fields.find((f: { api_name: string }) => f.api_name === 'message');
    expect(message.required_when).toEqual({ field: 'name', op: 'eq', value: 'must-answer' });
  });

  it('does NOT require the field while its own condition does not hold, but DOES once it does', async () => {
    const notYet = await pub('POST', '/public/forms/tok-condreq', { values: { name: 'someone else' } });
    expect(notYet.statusCode, notYet.body).toBe(201);
    const nowRequired = await pub('POST', '/public/forms/tok-condreq', { values: { name: 'must-answer' } });
    expect(nowRequired.statusCode).toBe(422);
  });

  it('accepts the value once the condition holds and it is provided — the server independently re-evaluates the condition, not trusting the client', async () => {
    const res = await pub('POST', '/public/forms/tok-condreq', {
      values: { name: 'must-answer', message: 'answered' },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('drops a DANGLING required_when rather than making the field permanently required — reverting to plain `required`', async () => {
    const orphan = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Not on this form', type: 'text' })
    ).json().id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'DanglingRequired',
      type: 'form',
      config: {
        sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {},
        form: {
          access: 'public',
          public_token: 'tok-dangling-required',
          fields: [
            { field_id: nameFieldId },
            { field_id: msgFieldId, required: true, required_when: { field_id: orphan, op: 'not_empty' } },
          ],
        },
      },
    });
    const def = (await pub('GET', '/public/forms/tok-dangling-required')).json();
    const message = def.fields.find((f: { api_name: string }) => f.api_name === 'message');
    expect(message.required_when).toBeUndefined();
    // No required_when survived translation, so `required: true` reverts to its
    // pre-#500 meaning: unconditionally required — this is the existing,
    // untouched behaviour forms.test.ts's "enforces the form required flags"
    // test already covers for the no-rule-at-all case; here it's the same
    // outcome reached via a rule that got dropped rather than never written.
    const res = await pub('POST', '/public/forms/tok-dangling-required', { values: { name: 'x' } });
    expect(res.statusCode).toBe(422);
  });
});
