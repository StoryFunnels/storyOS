import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { verifySignature } from '../src/webhooks/webhook-sender';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let dbId: string;
let webhooks: WebhooksService;

/** Every request the dispatcher tried to send. */
let sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let nextStatus = 200;

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Hooker');
  member = await signUpUser(app, 'PlainMember');
  wsId = (await inject('POST', '/workspaces', { name: 'Webhook WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  // The non-admin has to actually BE in the workspace, or "rejects a non-admin"
  // only ever proves that strangers get a 404 — see the test below.
  const invite = await inject('POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accepted = await inject('POST', '/invites/accept', { token: inviteToken }, member.token);
  if (accepted.statusCode >= 300) throw new Error(`member invite failed: ${accepted.body}`);

  webhooks = app.get(WebhooksService);
  // example.com is public, so assertPublicHost resolves it — but nothing leaves
  // the process: the fetcher is swapped for a recorder.
  webhooks.fetcher = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { status: nextStatus };
  };
});

afterAll(async () => {
  await app.close();
});

describe('webhook subscriptions (MN-032)', () => {
  it('returns the signing secret once at create, and never again', async () => {
    const created = await inject('POST', `/workspaces/${wsId}/webhooks`, {
      url: 'https://example.com/hook',
      events: ['record.created'],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().secret).toMatch(/^whsec_/);

    const listed = await inject('GET', `/workspaces/${wsId}/webhooks`);
    expect(listed.json().data).toHaveLength(1);
    expect(listed.json().data[0].secret).toBeUndefined();

    await inject('DELETE', `/workspaces/${wsId}/webhooks/${created.json().id}`);
  });

  /**
   * A webhook holds a signing secret and makes the server send record data
   * outbound, so `@MinRole('admin')` is the thing under test — not workspace
   * scoping. This used to accept `[403, 404]` from a user who had never been
   * invited: the 404 came from the scoping guard, the admin guard never ran, and
   * downgrading the controller to `@MinRole('member')` left the file green.
   * The member is now really a member, so only the admin guard can produce a 403.
   */
  it('rejects a non-admin', async () => {
    const create = await inject(
      'POST',
      `/workspaces/${wsId}/webhooks`,
      { url: 'https://example.com/hook', events: ['record.created'] },
      member.token,
    );
    expect(create.statusCode, `a member must be refused, not 404'd: ${create.body}`).toBe(403);

    // Reading the list leaks which endpoints a workspace calls — admin-only too.
    const list = await inject('GET', `/workspaces/${wsId}/webhooks`, undefined, member.token);
    expect(list.statusCode, `listing must be admin-only: ${list.body}`).toBe(403);
  });

  it('the member IS in the workspace — otherwise the test above proves nothing', async () => {
    // The positive control for the 403s: this member reaches ordinary member
    // routes in this exact workspace, so the refusals above are about the admin
    // rung, not about membership.
    expect((await inject('GET', `/workspaces/${wsId}/databases`, undefined, member.token)).statusCode).toBe(200);
  });

  it('rejects http, loopback and private hosts (SSRF)', async () => {
    for (const url of [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const res = await inject('POST', `/workspaces/${wsId}/webhooks`, {
        url,
        events: ['record.created'],
      });
      expect(res.statusCode, url).toBe(422);
    }
  });
});

describe('dispatch (MN-032)', () => {
  it('delivers a signed record.created, and never replays history', async () => {
    // Written BEFORE the subscription exists: the cursor must skip it.
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Older than the webhook' },
    });

    const hook = (
      await inject('POST', `/workspaces/${wsId}/webhooks`, {
        url: 'https://example.com/hook',
        database_id: dbId,
        events: ['record.created'],
      })
    ).json();

    sent = [];
    nextStatus = 200;
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Triggers the hook' },
    });
    await webhooks.tick();

    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call!.url).toBe('https://example.com/hook');

    // The payload carries the record, the change type and the database ref (AC).
    const body = JSON.parse(call!.body);
    expect(body.event).toBe('record.created');
    expect(body.record.title).toBe('Triggers the hook');
    expect(body.database.id).toBe(dbId);
    expect(body.workspace.id).toBe(wsId);

    // …and it verifies against the secret handed out at create.
    const ts = Number(call!.headers['X-StoryOS-Timestamp']);
    expect(verifySignature(hook.secret, call!.body, ts, call!.headers['X-StoryOS-Signature']!)).toBe(true);

    const status = (await inject('GET', `/workspaces/${wsId}/webhooks`)).json().data[0];
    expect(status.last_status).toBe('ok');

    await inject('DELETE', `/workspaces/${wsId}/webhooks/${hook.id}`);
  });

  it('only delivers subscribed event types', async () => {
    const hook = (
      await inject('POST', `/workspaces/${wsId}/webhooks`, {
        url: 'https://example.com/updates-only',
        database_id: dbId,
        events: ['record.updated'],
      })
    ).json();

    sent = [];
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: 'Created then updated' },
      })
    ).json();
    await webhooks.tick();
    expect(sent, 'record.created must not fire an updates-only hook').toHaveLength(0);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'Renamed' },
    });
    await webhooks.tick();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body).event).toBe('record.updated');

    await inject('DELETE', `/workspaces/${wsId}/webhooks/${hook.id}`);
  });

  it('retries a failure with backoff instead of dropping it', async () => {
    const hook = (
      await inject('POST', `/workspaces/${wsId}/webhooks`, {
        url: 'https://example.com/flaky',
        database_id: dbId,
        events: ['record.created'],
      })
    ).json();

    sent = [];
    nextStatus = 500;
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Fails first' },
    });
    await webhooks.tick();
    expect(sent).toHaveLength(1);

    // Still pending with a future attempt — not lost, not hammered.
    const after = (await inject('GET', `/workspaces/${wsId}/webhooks/${hook.id}/deliveries`)).json().data;
    expect(after[0].status).toBe('pending');
    expect(after[0].attempts).toBe(1);
    expect(new Date(after[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // A second tick must NOT re-send while the backoff is unexpired.
    await webhooks.tick();
    expect(sent, 'backoff must hold the retry').toHaveLength(1);

    const status = (await inject('GET', `/workspaces/${wsId}/webhooks`)).json().data.find(
      (w: { id: string }) => w.id === hook.id,
    );
    expect(status.last_status).toBe('failed');

    nextStatus = 200;
    await inject('DELETE', `/workspaces/${wsId}/webhooks/${hook.id}`);
  });

  it('does not deliver events from another database', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const otherDb = (
      await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Other' })
    ).json().id;

    const hook = (
      await inject('POST', `/workspaces/${wsId}/webhooks`, {
        url: 'https://example.com/scoped',
        database_id: dbId,
        events: ['record.created'],
      })
    ).json();

    sent = [];
    nextStatus = 200;
    await inject('POST', `/workspaces/${wsId}/databases/${otherDb}/records`, {
      values: { name: 'Wrong database' },
    });
    await webhooks.tick();
    expect(sent).toHaveLength(0);

    await inject('DELETE', `/workspaces/${wsId}/webhooks/${hook.id}`);
  });

  it('stops delivering once disabled', async () => {
    const hook = (
      await inject('POST', `/workspaces/${wsId}/webhooks`, {
        url: 'https://example.com/toggle',
        database_id: dbId,
        events: ['record.created'],
      })
    ).json();
    await inject('PATCH', `/workspaces/${wsId}/webhooks/${hook.id}`, { enabled: false });

    sent = [];
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Should not deliver' },
    });
    await webhooks.tick();
    expect(sent).toHaveLength(0);

    await inject('DELETE', `/workspaces/${wsId}/webhooks/${hook.id}`);
  });
});
