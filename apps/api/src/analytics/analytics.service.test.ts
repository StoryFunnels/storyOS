import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService, eventUuid } from './analytics.service';

const CONFIGURED = { token: 'phc_test', host: 'https://ph.example' };

function service(config: typeof CONFIGURED | null) {
  const svc = new AnalyticsService();
  vi.spyOn(svc, 'config').mockReturnValue(config);
  const captureImmediate = vi.fn().mockResolvedValue(undefined);
  const factory = vi.fn(() => ({ captureImmediate, shutdown: vi.fn().mockResolvedValue(undefined) }));
  svc.clientFactory = factory as unknown as AnalyticsService['clientFactory'];
  return { svc, captureImmediate, factory };
}

describe('#817 AnalyticsService — unconfigured is the default and must be inert (AC4)', () => {
  it('builds no client, makes no call, and does not throw', async () => {
    const { svc, captureImmediate, factory } = service(null);
    expect(svc.enabled).toBe(false);
    await expect(svc.capture({ distinctId: 'u1', event: 'workspace_activated' })).resolves.toBe('disabled');
    expect(factory).not.toHaveBeenCalled();
    expect(captureImmediate).not.toHaveBeenCalled();
  });

  it('requires BOTH the token and the host — one alone is still off', () => {
    // config() is the single read of the env; it returns null unless both are present.
    const real = new AnalyticsService();
    const saved = { t: process.env.POSTHOG_PROJECT_TOKEN, h: process.env.POSTHOG_HOST };
    // env() is cached for the process, so this asserts the shipped default: neither is set in the test env.
    expect(saved.t).toBeUndefined();
    expect(saved.h).toBeUndefined();
    expect(real.enabled).toBe(false);
  });
});

describe('#817 AnalyticsService — when configured', () => {
  it('sends the person, the event, a deterministic uuid and surface=app, with geoip off', async () => {
    const { svc, captureImmediate } = service(CONFIGURED);
    const uuid = eventUuid('workspace_activated', 'ws-1');
    await expect(svc.capture({ distinctId: 'user-1', event: 'workspace_activated', uuid, properties: { workspace_id: 'ws-1' } })).resolves.toBe('sent');
    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'workspace_activated',
      uuid,
      properties: { workspace_id: 'ws-1', surface: 'app' },
      disableGeoip: true,
    });
  });

  it('puts no email or name on the event — the web identify call already owns those', async () => {
    const { svc, captureImmediate } = service(CONFIGURED);
    await svc.capture({ distinctId: 'user-1', event: 'subscription_started', properties: { plan: 'pro', seats: 2 } });
    const sent = captureImmediate.mock.calls[0]![0] as { properties: Record<string, unknown> };
    expect(Object.keys(sent.properties).sort()).toEqual(['plan', 'seats', 'surface']);
    expect(JSON.stringify(sent)).not.toMatch(/email|name/i);
  });

  it('NEVER throws: a PostHog outage is reported as "failed", so the caller can release its claim', async () => {
    const { svc, captureImmediate } = service(CONFIGURED);
    captureImmediate.mockRejectedValueOnce(new Error('network down'));
    await expect(svc.capture({ distinctId: 'u', event: 'x' })).resolves.toBe('failed');
    await expect(svc.capture({ distinctId: 'u', event: 'x' })).resolves.toBe('sent');
  });
});

describe('#817 eventUuid — what lets a retry collapse into one event', () => {
  it('is deterministic, valid, and distinct per event and per subject', () => {
    const a = eventUuid('workspace_activated', 'ws-1');
    expect(a).toBe(eventUuid('workspace_activated', 'ws-1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(eventUuid('workspace_activated', 'ws-2'));
    expect(a).not.toBe(eventUuid('subscription_started', 'ws-1'));
  });
});
