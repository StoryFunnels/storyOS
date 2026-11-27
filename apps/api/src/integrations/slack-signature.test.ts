import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SLACK_TIMESTAMP_TOLERANCE_SECONDS, verifySlackSignature } from './slack-signature';

const SECRET = 'a-slack-signing-secret-for-tests';
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function sign(body: string, ts: number | string, secret = SECRET) {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function check(over: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) {
  const body = over.rawBody ? over.rawBody.toString('utf8') : '{"type":"event_callback"}';
  const ts = over.timestamp ?? String(NOW_S);
  return verifySlackSignature({
    signingSecret: SECRET,
    timestamp: ts,
    signature: sign(body, ts),
    rawBody: Buffer.from(body),
    nowMs: NOW_MS,
    ...over,
  });
}

describe('verifySlackSignature (ticket #1379)', () => {
  it('accepts a correctly signed, fresh request', () => {
    expect(check()).toBe(true);
  });

  it('FAILS CLOSED with no signing secret: unset, empty and whitespace all refuse, even a "valid" signature', () => {
    for (const signingSecret of [undefined, null, '', '   ']) {
      // The signature below is valid for the empty secret too, which is exactly what a naive implementation would accept.
      const body = '{"a":1}';
      const ts = String(NOW_S);
      expect(
        verifySlackSignature({ signingSecret, timestamp: ts, signature: sign(body, ts, ''), rawBody: Buffer.from(body), nowMs: NOW_MS }),
      ).toBe(false);
    }
  });

  it('refuses a signature made with another secret, a tampered body, and a tampered timestamp', () => {
    const body = '{"type":"event_callback"}';
    const ts = String(NOW_S);
    expect(check({ signature: sign(body, ts, 'other-secret') })).toBe(false);
    expect(check({ rawBody: Buffer.from(body.replace('event_callback', 'url_verification')), signature: sign(body, ts) })).toBe(false);
    expect(check({ timestamp: String(NOW_S + 1), signature: sign(body, ts) })).toBe(false);
  });

  it('refuses missing or malformed signature headers without throwing (length mismatch must not crash the compare)', () => {
    for (const signature of [undefined, '', 'v0=', 'v0=short', 'v1=' + 'a'.repeat(64), 'a'.repeat(64), `v0=${'z'.repeat(64)}`]) {
      expect(check({ signature })).toBe(false);
    }
  });

  it('refuses a missing raw body (the allowlist did not retain the bytes)', () => {
    expect(check({ rawBody: undefined as never, signature: sign('x', NOW_S) })).toBe(false);
  });

  it('enforces the five minute window in BOTH directions, and the boundary itself is inside', () => {
    expect(SLACK_TIMESTAMP_TOLERANCE_SECONDS).toBe(300);
    const at = (ts: number) => check({ timestamp: String(ts), signature: sign('{"type":"event_callback"}', ts) });
    expect(at(NOW_S - 300)).toBe(true);
    expect(at(NOW_S + 300)).toBe(true);
    expect(at(NOW_S - 301)).toBe(false);
    expect(at(NOW_S + 301)).toBe(false);
  });

  it('refuses a timestamp that is not a plain integer, even when it would sign correctly', () => {
    for (const ts of ['', 'abc', '1.5e9', '0x10', `${NOW_S}.5`, ' ' + NOW_S, 'NaN', 'Infinity', '-1']) {
      const body = '{"type":"event_callback"}';
      expect(check({ timestamp: ts, signature: sign(body, ts) }), JSON.stringify(ts)).toBe(false);
    }
  });
});
