import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SourcesService } from './sources.service';
import type { ConnectionsService } from '../connections/connections.service';
import type { ConnectionFetcher } from '../connections/providers/types';

/**
 * #341 — the channel-picker endpoint's service method. `listYoutubeChannels`
 * touches neither the DB nor the scheduler, so it's testable by constructing
 * the service with only the collaborators it uses (ConnectionsService) plus a
 * mocked YouTube fetcher — the same `fetcher` seam the provider tests use.
 */
function makeService(opts: {
  auth?: { provider: string; auth: unknown };
  authThrows?: boolean;
  channelsBody?: unknown;
}) {
  const getDecryptedAuth = vi.fn(async () => {
    if (opts.authThrows) throw new Error('gone');
    return opts.auth!;
  });
  const connectionsService = { getDecryptedAuth } as unknown as ConnectionsService;
  const service = new SourcesService(
    null as never, // db — unused by listYoutubeChannels
    null as never, // recordsService — unused
    connectionsService,
    null as never, // notifications — unused
  );
  const calls: string[] = [];
  const fetcher: ConnectionFetcher = async (url) => {
    calls.push(url);
    return { status: 200, json: async () => opts.channelsBody ?? { items: [] }, text: async () => '' };
  };
  service.fetcher = fetcher;
  return { service, getDecryptedAuth, calls };
}

describe('SourcesService.listYoutubeChannels', () => {
  it('reuses the connection token and returns the mapped channel list', async () => {
    const { service, getDecryptedAuth, calls } = makeService({
      auth: { provider: 'google', auth: { access_token: 'ya29.test' } },
      channelsBody: { items: [{ id: 'UC1', snippet: { title: 'My Channel' } }] },
    });
    const result = await service.listYoutubeChannels('ws1', 'conn1');
    expect(result).toEqual({ data: [{ id: 'UC1', title: 'My Channel' }] });
    expect(getDecryptedAuth).toHaveBeenCalledWith('ws1', 'conn1');
    expect(calls[0]).toContain('mine=true');
  });

  it('rejects a non-google connection', async () => {
    const { service } = makeService({ auth: { provider: 'github', auth: {} } });
    await expect(service.listYoutubeChannels('ws1', 'conn1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a missing/foreign connection to NotFound', async () => {
    const { service } = makeService({ authThrows: true });
    await expect(service.listYoutubeChannels('ws1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
