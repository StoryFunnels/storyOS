import { describe, expect, it } from 'vitest';
import { PostSocialActionService } from '../automations/post-social.action';
import { SocialAccountsService } from '../connections/social-accounts.service';
import { RealNetworkRefused, failClosedFetch } from './test-network-guard';

/**
 * Ticket #42 — the default fetcher of every social network client FAILS CLOSED under test. A reviewer's probe once reached
 * api.twitter.com through the picker's default fetcher with a fake token. Nothing was posted, but it must be impossible.
 */
describe('a social network client cannot make a real request from a test unless a fetcher was supplied', () => {
  it('the guard itself refuses, naming the host and how to fix the test', async () => {
    const err = await failClosedFetch()('https://api.twitter.com/2/users/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealNetworkRefused);
    expect((err as Error).message).toContain('api.twitter.com');
    expect((err as Error).message).toContain('fetcher');
  });

  it("the account picker's DEFAULT fetcher refuses (no request leaves the process)", async () => {
    const picker = new SocialAccountsService({} as never, {} as never);
    const err = await picker.fetcher('https://api.linkedin.com/v2/userinfo', { headers: { authorization: 'Bearer fake' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealNetworkRefused);
  });

  it("the publish executor's DEFAULT fetcher refuses too", async () => {
    const exec = new PostSocialActionService({} as never, {} as never, {} as never, {} as never);
    const err = await exec.fetcher('https://api.twitter.com/2/tweets', { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealNetworkRefused);
  });
});
