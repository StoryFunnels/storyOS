import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact-secrets';

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
});
