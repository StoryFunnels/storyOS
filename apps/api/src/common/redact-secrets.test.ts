import { describe, expect, it } from 'vitest';
import { redactLiteralValues, redactSecrets } from './redact-secrets';

describe('redactSecrets', () => {
  it('masks integration secrets but keeps non-secret siblings', () => {
    const out = redactSecrets({
      linear: { api_key: 'lin_api_L9fBxxxxao6F', team_keys: ['SF', 'ENG'] },
      github: { token: 'ghp_secret', repos: ['a/b'] },
      theme: 'dark',
    });
    expect(out).toEqual({
      linear: { api_key: '[redacted]', team_keys: ['SF', 'ENG'] },
      github: { token: '[redacted]', repos: ['a/b'] },
      theme: 'dark',
    });
  });

  it('masks Slack bot token and webhook URL but keeps the default channel', () => {
    const out = redactSecrets({
      slack: { bot_token: 'xoxb-123', webhook_url: 'https://hooks.slack.com/services/T/B/secret', default_channel: '#general' },
    });
    expect(out).toEqual({
      slack: { bot_token: '[redacted]', webhook_url: '[redacted]', default_channel: '#general' },
    });
  });

  it('covers camelCase and nested secret keys', () => {
    const out = redactSecrets({ a: { accessToken: 'x', clientSecret: 'y', password: 'z', keep: 1 } });
    expect(out).toEqual({ a: { accessToken: '[redacted]', clientSecret: '[redacted]', password: '[redacted]', keep: 1 } });
  });

  it('leaves empty/absent values and identifier-like keys alone', () => {
    expect(redactSecrets({ token: '', team_keys: ['SF'], apiKeyLabel: 'prod' })).toEqual({
      token: '',
      team_keys: ['SF'],
      apiKeyLabel: 'prod',
    });
  });

  /**
   * The regression that motivated the rewrite: `webhook_secret` was invisible to
   * the old exact-name denylist. The point of these is that no entry was added
   * for any of them — the tail pattern covers a prefix nobody has written yet.
   */
  it.each([
    'webhook_secret',
    'webhook_signing_secret',
    'github_pat',
    'refreshToken',
    'client_secret',
    'deploy_private_key',
    'password2',
  ])('covers an unforeseen prefix on a known secret tail: %s', (key) => {
    expect(redactSecrets({ github: { [key]: 'shh' } })).toEqual({ github: { [key]: '[redacted]' } });
  });

  it('does not redact presence flags, identifiers or labels (a redaction bug hides real data)', () => {
    const out = redactSecrets({
      github: {
        has_token: true,
        has_webhook_secret: false,
        token_prefix: 'mn_pat_ab12…cd34',
        api_key_id: 'ak_9f2',
        public_key: 'ssh-ed25519 AAAA…',
        webhook_actor_id: 'usr_1',
        repos: ['a/b'],
      },
    });
    expect(out).toEqual({
      github: {
        has_token: true,
        has_webhook_secret: false,
        token_prefix: 'mn_pat_ab12…cd34',
        api_key_id: 'ak_9f2',
        public_key: 'ssh-ed25519 AAAA…',
        webhook_actor_id: 'usr_1',
        repos: ['a/b'],
      },
    });
  });

  it('redacts through arrays of nested objects', () => {
    const out = redactSecrets({
      actions: [
        { type: 'send_slack_message', text: 'hi' },
        { type: 'send_webhook', url: 'https://ci.example.com/hook', body_template: '{}' },
      ],
      creds: [{ private_key: 'MIIE…' }],
    });
    expect(out).toEqual({
      actions: [
        { type: 'send_slack_message', text: 'hi' },
        { type: 'send_webhook', url: 'https://ci.example.com/hook', body_template: '{}' },
      ],
      creds: [{ private_key: '[redacted]' }],
    });
  });

  /** A `send_webhook` header map is where `Authorization: Bearer …` actually lives. */
  it('blanks every value in a headers map, keeping the header names', () => {
    const out = redactSecrets({
      type: 'send_webhook',
      url: 'https://ci.example.com/hook',
      headers: {
        Authorization: 'Bearer ghp_realtoken',
        'X-Circle-Auth': 'circle_abc',
        'content-type': 'application/json',
      },
    });
    expect(out).toEqual({
      type: 'send_webhook',
      url: 'https://ci.example.com/hook',
      headers: {
        Authorization: '[redacted]',
        'X-Circle-Auth': '[redacted]',
        'content-type': '[redacted]',
      },
    });
  });

  /**
   * MN-252: a connection's `auth` is the raw provider-specific credential
   * payload (whatever shape that provider's healthCheck/seal expects — an
   * `api_key`, an OAuth token pair, …). There's no fixed sub-key to pattern
   * match, so the whole object is redacted wholesale, same as `credential`/
   * `credentials` — unlike `headers`, this is not a per-value container.
   */
  it('redacts a connection auth payload wholesale, regardless of its provider-specific shape', () => {
    const out = redactSecrets({
      provider: 'apify',
      name: 'Prod Apify',
      auth: { api_key: 'apify_api_abc123' },
    });
    expect(out).toEqual({
      provider: 'apify',
      name: 'Prod Apify',
      auth: '[redacted]',
    });
  });

  /** webhookUrlSchema accepts `https://user:pass@host` — the key `url` says nothing. */
  it('strips userinfo out of a URL whose key looks innocent', () => {
    expect(
      redactSecrets({ url: 'https://deploy:s3cr3t@ci.example.com/hook?x=1', note: 'no creds here' }),
    ).toEqual({
      url: 'https://[redacted]@ci.example.com/hook?x=1',
      note: 'no creds here',
    });
  });
});

/** MN-263 — the http_request action's defense against a connection token echoed
 * back verbatim inside someone else's response JSON, where no key-shape exists
 * to redact by. */
describe('redactLiteralValues', () => {
  it('scrubs every occurrence of a known secret value, wherever it appears', () => {
    const body = '{"echoed_auth":"Bearer sekrit-tok-123","ok":true,"again":"sekrit-tok-123 in prose too"}';
    expect(redactLiteralValues(body, ['sekrit-tok-123'])).toBe(
      '{"echoed_auth":"Bearer [redacted]","ok":true,"again":"[redacted] in prose too"}',
    );
  });

  it('redacts multiple distinct secrets in one pass', () => {
    expect(redactLiteralValues('user=alice pass=hunter2', ['alice', 'hunter2'])).toBe(
      'user=[redacted] pass=[redacted]',
    );
  });

  it('ignores empty/undefined/too-short entries rather than mangling the text', () => {
    expect(redactLiteralValues('the cat sat', [undefined, '', 'a', 'at'])).toBe('the cat sat');
  });

  it('leaves text with no matching secret untouched', () => {
    expect(redactLiteralValues('nothing secret here', ['totally-different-token'])).toBe('nothing secret here');
  });
});
