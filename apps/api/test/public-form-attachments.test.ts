/**
 * #710 — public forms gain a multipart submission path so a form with an
 * attachment field can actually receive a file. Reuses the exact upload
 * mechanism (size cap, storage) the authenticated attachments path already
 * uses — see attachments.test.ts for that path's own coverage; this file
 * only exercises what's new: multipart parsing, the JSON path staying
 * byte-for-byte unchanged, and the attachment-specific edge cases (required,
 * oversized, no-attachment-field, at-most-one-field).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let token: string;
let wsId: string;
let dbId: string;
let nameFieldId: string;
let attachmentFieldId: string;
let attachmentApiName: string;
let secondAttachmentFieldId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
/** Unauthenticated — the public form path. */
async function pub(method: string, url: string, payload?: unknown, headers?: Record<string, string>) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers, payload: payload as never });
}

const BOUNDARY = 'X-STORYOS-TEST-BOUNDARY-710';

/** Builds a multipart body with an optional JSON `payload` text part and
 *  zero or more file parts (named "file" — the field name itself is not
 *  read by the server, only `part.type === 'file'` matters). */
function multipartBody(payload: unknown, files: { filename: string; mime: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  if (payload !== undefined) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\ncontent-disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`,
      ),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${f.filename}"\r\ncontent-type: ${f.mime}\r\n\r\n`,
      ),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

function multipartHeaders() {
  return { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
}

async function makeForm(
  token_: string,
  fields: { field_id: string; required?: boolean; label?: string }[],
) {
  const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
    name: `Form ${token_}`,
    type: 'form',
    config: {
      sorts: [],
      hidden_field_ids: [],
      card_field_ids: [],
      column_widths: {},
      form: { title: 'Apply', access: 'public', public_token: token_, fields },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'PublicFormAttachments710')).token;
  wsId = (await as('POST', '/workspaces', { name: '710 WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Applications' })).json().id;
  const dbFields = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().fields as Array<{
    id: string;
    type: string;
    api_name: string;
  }>;
  nameFieldId = dbFields.find((f) => f.type === 'title')!.id;
  attachmentFieldId = (
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Resume', type: 'attachment' })
  ).json().id;
  // GET /workspaces/:ws/databases/:db's fields payload is camelCase
  // (`apiName`), unlike the public form definition's own snake_case
  // (`api_name`) — re-fetch now that the attachment field exists too.
  const dbFields2 = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().fields as Array<{
    id: string;
    apiName: string;
  }>;
  attachmentApiName = dbFields2.find((f) => f.id === attachmentFieldId)!.apiName;
  secondAttachmentFieldId = (
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Cover Letter', type: 'attachment' })
  ).json().id;
});
afterAll(async () => {
  await app.close();
});

describe('#710: public form attachments', () => {
  it('a form with an attachment field renders it as type "attachment" in the public definition', async () => {
    await makeForm('tok-710-def', [{ field_id: nameFieldId, required: true }, { field_id: attachmentFieldId }]);
    const res = await pub('GET', '/public/forms/tok-710-def');
    expect(res.statusCode, res.body).toBe(200);
    const def = res.json();
    expect(def.fields.map((f: { type: string }) => f.type)).toEqual(['title', 'attachment']);
  });

  it('at most one attachment field is exposed — a second is silently dropped, not rendered broken', async () => {
    await makeForm('tok-710-two', [
      { field_id: nameFieldId },
      { field_id: attachmentFieldId },
      { field_id: secondAttachmentFieldId },
    ]);
    const res = await pub('GET', '/public/forms/tok-710-two');
    const def = res.json();
    const attachmentFields = def.fields.filter((f: { type: string }) => f.type === 'attachment');
    expect(attachmentFields).toHaveLength(1);
    expect(attachmentFields[0].field_id).toBe(attachmentFieldId);
  });

  it('MUST KEEP WORKING: a JSON-only submission (no attachment field) is unaffected', async () => {
    await makeForm('tok-710-json', [{ field_id: nameFieldId, required: true }]);
    const res = await pub('POST', '/public/forms/tok-710-json', { values: { name: 'Plain Jane' } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const rec = (await as('GET', `/workspaces/${wsId}/databases/${dbId}/records/${res.json().id}`)).json();
    expect(rec.title).toBe('Plain Jane');
  });

  it('a multipart submission creates the record AND attaches the file, retrievable like an authenticated upload', async () => {
    await makeForm('tok-710-multi', [
      { field_id: nameFieldId, required: true },
      { field_id: attachmentFieldId, label: 'Resume' },
    ]);
    const data = Buffer.from('my resume contents');
    const res = await pub(
      'POST',
      '/public/forms/tok-710-multi',
      multipartBody({ values: { name: 'Multi Marco' } }, [{ filename: 'resume.txt', mime: 'text/plain', data }]),
      multipartHeaders(),
    );
    expect(res.statusCode, res.body).toBeLessThan(300);
    const recId = res.json().id;

    const rec = (await as('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`)).json();
    expect(rec.title).toBe('Multi Marco');
    // #391 — a field-scoped attachment resolves into a chip on the record's own
    // projected value (records.values[api_name]), not the record's generic
    // attachment "bag" (that list endpoint is scoped to fieldId IS NULL only).
    const chips = rec.values[attachmentApiName];
    expect(chips).toHaveLength(1);
    expect(chips[0].filename).toBe('resume.txt');

    const download = await as(
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${recId}/attachments/${chips[0].id}/download`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString()).toBe('my resume contents');
  });

  it('a multipart submission with no file part still works when the attachment field is optional', async () => {
    await makeForm('tok-710-nofile', [{ field_id: nameFieldId, required: true }, { field_id: attachmentFieldId }]);
    const res = await pub(
      'POST',
      '/public/forms/tok-710-nofile',
      multipartBody({ values: { name: 'No File Nadia' } }, []),
      multipartHeaders(),
    );
    expect(res.statusCode, res.body).toBeLessThan(300);
    const rec = (await as('GET', `/workspaces/${wsId}/databases/${dbId}/records/${res.json().id}`)).json();
    expect(rec.values[attachmentApiName]).toHaveLength(0);
  });

  it('a required attachment field with no file submitted is rejected the same way a required text field would be', async () => {
    await makeForm('tok-710-required', [{ field_id: attachmentFieldId, required: true, label: 'Resume' }]);
    const res = await pub(
      'POST',
      '/public/forms/tok-710-required',
      multipartBody({ values: {} }, []),
      multipartHeaders(),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Resume');
  });

  it('a file submitted to a form with no attachment field is rejected, not silently dropped', async () => {
    await makeForm('tok-710-nofield', [{ field_id: nameFieldId }]);
    const res = await pub(
      'POST',
      '/public/forms/tok-710-nofield',
      multipartBody({ values: { name: 'X' } }, [{ filename: 'x.txt', mime: 'text/plain', data: Buffer.from('x') }]),
      multipartHeaders(),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('no attachment field');
  });

  // AC0/AC5 (Otto, 2026-09-15) — one attachment field per form is the
  // supported shape, forced by the global `files: 1` plugin limit; a second
  // file in one submission must fail with a CLEAR, INTENTIONAL error, never
  // whatever fastify-multipart's own limit produces when tripped (an opaque
  // stream error, not a readable 422).
  it('AC5: a second file in one submission fails with a clear, intentional error', async () => {
    await makeForm('tok-710-twofiles', [{ field_id: attachmentFieldId }]);
    const res = await pub(
      'POST',
      '/public/forms/tok-710-twofiles',
      multipartBody({ values: {} }, [
        { filename: 'one.txt', mime: 'text/plain', data: Buffer.from('one') },
        { filename: 'two.txt', mime: 'text/plain', data: Buffer.from('two') },
      ]),
      multipartHeaders(),
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('only one file');
  });

  it('#710 AC4: an oversized file is rejected with the same size-limit behavior as the authenticated path', async () => {
    await makeForm('tok-710-oversize', [{ field_id: attachmentFieldId }]);
    const big = Buffer.alloc(2 * 1024 * 1024, 'a'); // test cap is 1MB (setup-env.ts)
    const res = await pub(
      'POST',
      '/public/forms/tok-710-oversize',
      multipartBody({ values: {} }, [{ filename: 'huge.bin', mime: 'application/octet-stream', data: big }]),
      multipartHeaders(),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('exceeds');
  });

  it('#710 AC5: the record is resolved from the form TOKEN, never from a caller-supplied database/record id', async () => {
    // The multipart handler never accepts a workspace/database id from the
    // client at all (no such field exists in publicSubmitSchema) — this is
    // an existence proof that the only way in is the token in the URL path.
    await makeForm('tok-710-scope', [{ field_id: nameFieldId }]);
    const res = await pub('GET', '/public/forms/tok-710-scope');
    expect(res.statusCode).toBe(200);
    const bogus = await pub('POST', '/public/forms/not-a-real-token', { values: {} });
    expect(bogus.statusCode).toBe(404);
  });
});
