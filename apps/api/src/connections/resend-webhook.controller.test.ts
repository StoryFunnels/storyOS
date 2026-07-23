import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySvixSignature } from './resend-webhook.controller';

/** MN-256 — the Svix HMAC scheme Resend's webhooks use, exercised without a
 * network (mirrors github-webhook.service.ts's own verifySignature tests). */
describe('verifySvixSignature', () => {
  const secret = 'whsec_' + Buffer.from('a-test-secret-key-32-bytes-long!').toString('base64');
  const svixId = 'msg_test123';
  const svixTimestamp = '1700000000';
  const body = Buffer.from(JSON.stringify({ type: 'email.bounced' }));

  function sign(): string {
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signedContent = `${svixId}.${svixTimestamp}.${body.toString('utf8')}`;
    return `v1,${createHmac('sha256', secretBytes).update(signedContent).digest('base64')}`;
  }

  it('accepts a correctly signed delivery', () => {
    expect(verifySvixSignature(secret, svixId, svixTimestamp, body, sign())).toBe(true);
  });

  it('accepts when the header carries multiple space-separated signatures (key rotation)', () => {
    expect(verifySvixSignature(secret, svixId, svixTimestamp, body, `v1,bogusbase64== ${sign()}`)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifySvixSignature('whsec_' + Buffer.from('different-secret-key-32-bytes!!!').toString('base64'), svixId, svixTimestamp, body, sign())).toBe(false);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ type: 'email.complained' }));
    expect(verifySvixSignature(secret, svixId, svixTimestamp, tampered, sign())).toBe(false);
  });

  it('rejects a malformed signature header without throwing', () => {
    expect(verifySvixSignature(secret, svixId, svixTimestamp, body, 'not-a-real-signature')).toBe(false);
  });
});
