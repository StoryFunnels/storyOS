import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Node test environment (no jsdom) — window/navigator/document/Notification
 * don't exist by default, so each test stubs exactly what it needs and
 * restores afterward. Mirrors how the module itself guards for SSR.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('registerServiceWorker', () => {
  it('is a no-op when window is undefined (SSR)', async () => {
    const { registerServiceWorker } = await import('./service-worker');
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it('is a no-op when the browser has no serviceWorker support', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const { registerServiceWorker } = await import('./service-worker');
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it('registers immediately when the page has already finished loading', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    vi.stubGlobal('document', { readyState: 'complete' });

    const { registerServiceWorker } = await import('./service-worker');
    registerServiceWorker();

    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it('waits for the load event instead of registering immediately when the page is still loading', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const addEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    vi.stubGlobal('document', { readyState: 'loading' });

    const { registerServiceWorker } = await import('./service-worker');
    registerServiceWorker();

    expect(register).not.toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith('load', expect.any(Function), { once: true });
  });
});

describe('subscribeToPush', () => {
  it('returns null when NEXT_PUBLIC_VAPID_PUBLIC_KEY is not configured', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { serviceWorker: {} });
    const { subscribeToPush } = await import('./service-worker');
    await expect(subscribeToPush()).resolves.toBeNull();
  });

  it('returns null when notification permission is denied', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'BFakeKeyForTest_-_1234567890');
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

    const { subscribeToPush } = await import('./service-worker');
    await expect(subscribeToPush()).resolves.toBeNull();
  });

  it('subscribes once permission is granted and a VAPID key is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'BFakeKeyForTest_-_1234567890');
    const subscription = { endpoint: 'https://push.example/abc' };
    const subscribe = vi.fn().mockResolvedValue(subscription);
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) },
    });
    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });
    vi.stubGlobal('atob', (b64: string) => Buffer.from(b64, 'base64').toString('binary'));

    const { subscribeToPush } = await import('./service-worker');
    const result = await subscribeToPush();

    expect(result).toBe(subscription);
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    );
  });
});
