import { beforeEach, describe, expect, it, vi } from 'vitest';

const guardedFetchMock = vi.fn();
vi.mock('../common/net-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/net-guard')>();
  return { ...actual, guardedFetch: (...args: unknown[]) => guardedFetchMock(...args) };
});

import { SsrfBlockedError } from '../common/net-guard';
import { ProviderError } from '../common/provider-error';
import { HttpRequestActionService } from './http-request-action.service';
import type { HttpRequestJobPayload } from './http-request-action.service';

function fakeGuardedFetchResult(overrides: Partial<{ status: number; text: string; truncated: boolean }> = {}) {
  return {
    status: overrides.status ?? 200,
    headers: new Headers(),
    finalUrl: 'https://api.example.com/x',
    text: overrides.text ?? '{}',
    truncated: overrides.truncated ?? false,
  };
}

function newService(opts: {
  fieldsFindMany?: unknown[];
  recordsUpdate?: ReturnType<typeof vi.fn>;
} = {}) {
  const db = { query: { fields: { findMany: vi.fn().mockResolvedValue(opts.fieldsFindMany ?? []) } } };
  const jobs = { registerExecutor: vi.fn() };
  const connections = { getDecryptedAuth: vi.fn() };
  const records = { update: opts.recordsUpdate ?? vi.fn().mockResolvedValue(undefined) };
  const service = new HttpRequestActionService(db as never, jobs as never, connections as never, records as never);
  return { service, db, jobs, connections, records };
}

function payload(overrides: Partial<HttpRequestJobPayload['action']> = {}): HttpRequestJobPayload {
  return {
    action: {
      type: 'http_request',
      method: 'GET',
      url: 'https://api.example.com/x',
      ...overrides,
    } as HttpRequestJobPayload['action'],
    ctx: { workspaceId: 'ws1', databaseId: 'db1', recordId: 'rec1', actorId: 'user1', depth: 0 },
  };
}

function helpers(connectionAuth?: { provider: string; auth: unknown }) {
  return {
    connectionAuth: vi.fn().mockResolvedValue(connectionAuth ?? { provider: 'http', auth: {} }),
    fetcher: fetch,
    idempotencyKey: 'k1',
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  guardedFetchMock.mockReset();
});

describe('HttpRequestActionService.run — auth merge at send time (MN-263)', () => {
  it('registers itself as the http_request executor at boot', () => {
    const { service, jobs } = newService();
    service.onModuleInit();
    expect(jobs.registerExecutor).toHaveBeenCalledWith('http_request', expect.any(Function), { timeoutClass: 'short' });
  });

  it('merges a bearer token into Authorization, never into the stored action', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult());
    const { service } = newService();
    await service.run(payload({ connection_id: 'conn1' }), helpers({ provider: 'http', auth: { auth_style: 'bearer', token: 'tok-abc' } }));
    const [, , init] = guardedFetchMock.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok-abc');
  });

  it('merges basic auth as a base64 Authorization header', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult());
    const { service } = newService();
    await service.run(
      payload({ connection_id: 'conn1' }),
      helpers({ provider: 'http', auth: { auth_style: 'basic', username: 'alice', password: 'hunter2' } }),
    );
    const [, , init] = guardedFetchMock.mock.calls[0]!;
    const expected = `Basic ${Buffer.from('alice:hunter2').toString('base64')}`;
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(expected);
  });

  it('merges a headers-style connection as arbitrary static headers', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult());
    const { service } = newService();
    await service.run(
      payload({ connection_id: 'conn1', headers: { 'X-Existing': 'keep' } }),
      helpers({ provider: 'http', auth: { auth_style: 'headers', headers: { 'X-Api-Key': 'k-123' } } }),
    );
    const [, , init] = guardedFetchMock.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['X-Api-Key']).toBe('k-123');
    expect(headers['X-Existing']).toBe('keep');
  });

  it('never sends a body for GET even if body_template is set', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult());
    const { service } = newService();
    await service.run(payload({ method: 'GET', body_template: '{"a":1}' }), helpers());
    const [, , init] = guardedFetchMock.mock.calls[0]!;
    expect((init as { body?: string }).body).toBeUndefined();
  });

  it('sends a JSON body and defaults Content-Type for POST', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult());
    const { service } = newService();
    await service.run(payload({ method: 'POST', body_template: '{"a":1}' }), helpers());
    const [, , init] = guardedFetchMock.mock.calls[0]!;
    const typed = init as { body?: string; headers: Record<string, string> };
    expect(JSON.parse(typed.body!)).toEqual({ a: 1 });
    expect(typed.headers['Content-Type']).toBe('application/json');
  });
});

describe('HttpRequestActionService.run — capture (MN-263)', () => {
  it('captures a number path onto a number field, coercing a numeric string', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ text: '{"id":"42"}' }));
    const { service, records } = newService({
      fieldsFindMany: [{ id: 'f1', apiName: 'external_id', type: 'number' }],
    });
    const result = await service.run(
      payload({ capture: [{ path: '$.id', target_field_id: 'f1' }] }),
      helpers(),
    );
    expect(records.update).toHaveBeenCalledWith('ws1', 'db1', 'rec1', { external_id: 42 }, 'user1', 1);
    expect((result as { captured_fields: string[] }).captured_fields).toEqual(['external_id']);
  });

  it('captures an array-index path', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ text: '{"items":[{"tag":"first"},{"tag":"second"}]}' }));
    const { service, records } = newService({
      fieldsFindMany: [{ id: 'f2', apiName: 'tag', type: 'text' }],
    });
    await service.run(payload({ capture: [{ path: 'items.1.tag', target_field_id: 'f2' }] }), helpers());
    expect(records.update).toHaveBeenCalledWith('ws1', 'db1', 'rec1', { tag: 'second' }, 'user1', 1);
  });

  it('stringifies and truncates an object capture onto a non-number field', async () => {
    const big = { blob: 'x'.repeat(9_000) };
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ text: JSON.stringify({ obj: big }) }));
    const { service, records } = newService({
      fieldsFindMany: [{ id: 'f3', apiName: 'raw', type: 'text' }],
    });
    await service.run(payload({ capture: [{ path: 'obj', target_field_id: 'f3' }] }), helpers());
    const call = records.update.mock.calls[0]!;
    const value = (call[3] as Record<string, unknown>).raw as string;
    expect(value.length).toBe(8_000);
  });

  it('passes a boolean straight through onto a checkbox field', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ text: '{"active":true}' }));
    const { service, records } = newService({
      fieldsFindMany: [{ id: 'f4', apiName: 'is_active', type: 'checkbox' }],
    });
    await service.run(payload({ capture: [{ path: 'active', target_field_id: 'f4' }] }), helpers());
    expect(records.update).toHaveBeenCalledWith('ws1', 'db1', 'rec1', { is_active: true }, 'user1', 1);
  });

  it('reports capture_error (not a job failure) for a non-JSON 2xx response', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ text: 'plain text, not json' }));
    const { service, records } = newService({ fieldsFindMany: [{ id: 'f1', apiName: 'x', type: 'text' }] });
    const result = await service.run(payload({ capture: [{ path: 'x', target_field_id: 'f1' }] }), helpers());
    expect(records.update).not.toHaveBeenCalled();
    expect((result as { capture_error?: string }).capture_error).toMatch(/not valid JSON/);
  });

  it('skips (does not throw) a capture whose target field no longer exists', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ text: '{"id":1}' }));
    const { service, records } = newService({ fieldsFindMany: [] }); // field deleted since save
    const result = await service.run(payload({ capture: [{ path: 'id', target_field_id: 'gone' }] }), helpers());
    expect(records.update).not.toHaveBeenCalled();
    expect((result as { captured_fields: string[] }).captured_fields).toEqual([]);
  });
});

describe('HttpRequestActionService.run — retry classification (MN-253/263)', () => {
  it('treats a 5xx as retryable', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ status: 503, text: 'down' }));
    const { service } = newService();
    await expect(service.run(payload(), helpers())).rejects.toMatchObject({ retryable: true });
  });

  it('treats a 429 as retryable', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ status: 429, text: 'slow down' }));
    const { service } = newService();
    const err = await service.run(payload(), helpers()).catch<ProviderError>((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('treats a 4xx as NOT retryable', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ status: 404, text: 'nope' }));
    const { service } = newService();
    const err = await service.run(payload(), helpers()).catch<ProviderError>((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it('treats a network throw as retryable', async () => {
    guardedFetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const { service } = newService();
    const err = await service.run(payload(), helpers()).catch<ProviderError>((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('treats an SsrfBlockedError as NOT retryable — the target is refused every time', async () => {
    guardedFetchMock.mockRejectedValue(new SsrfBlockedError('refusing to call private address 10.0.0.1'));
    const { service } = newService();
    const err = await service.run(payload(), helpers()).catch<ProviderError>((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).message).toMatch(/private address/);
  });
});

describe('HttpRequestActionService.run — secret redaction (MN-263)', () => {
  it('redacts a connection token that appears literally in the response body', async () => {
    guardedFetchMock.mockResolvedValue(
      fakeGuardedFetchResult({ text: JSON.stringify({ echoed: 'Bearer tok-super-secret-999' }) }),
    );
    const { service } = newService();
    const result = await service.run(
      payload({ connection_id: 'conn1' }),
      helpers({ provider: 'http', auth: { auth_style: 'bearer', token: 'tok-super-secret-999' } }),
    );
    const body = (result as { body: string }).body;
    expect(body).not.toContain('tok-super-secret-999');
    expect(body).toContain('[redacted]');
  });

  it('redacts the connection token from a thrown 4xx/5xx error message too', async () => {
    guardedFetchMock.mockResolvedValue(
      fakeGuardedFetchResult({ status: 500, text: 'upstream saw Bearer tok-super-secret-999 and choked' }),
    );
    const { service } = newService();
    const err = (await service
      .run(payload({ connection_id: 'conn1' }), helpers({ provider: 'http', auth: { auth_style: 'bearer', token: 'tok-super-secret-999' } }))
      .catch((e) => e)) as ProviderError;
    expect(err.message).not.toContain('tok-super-secret-999');
  });
});

describe('HttpRequestActionService.sendForTest (MN-263)', () => {
  /**
   * Regression pin: a live click-through of "Send test request" against a
   * blocked address (169.254.169.254) surfaced as a raw 500 — guardedFetch's
   * SsrfBlockedError propagated straight out of sendForTest() uncaught,
   * past Nest's default exception filter (SsrfBlockedError extends Error,
   * not HttpException). This must come back as a clean 4xx with the real
   * refusal message instead, since the editor shows it inline.
   */
  it('turns an SSRF refusal into an UnprocessableEntityException, not an uncaught 500', async () => {
    guardedFetchMock.mockRejectedValue(new SsrfBlockedError('refusing to call blocked address 169.254.169.254'));
    const { service } = newService();
    await expect(
      service.sendForTest('ws1', 'db1', 'rec1', 'user1', {
        type: 'http_request',
        method: 'GET',
        url: 'http://169.254.169.254/latest/meta-data/',
      } as never),
    ).rejects.toMatchObject({ status: 422, message: 'refusing to call blocked address 169.254.169.254' });
  });

  it('turns a plain network failure into a 4xx too', async () => {
    guardedFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = newService();
    await expect(
      service.sendForTest('ws1', 'db1', 'rec1', 'user1', {
        type: 'http_request',
        method: 'GET',
        url: 'https://api.example.com/x',
      } as never),
    ).rejects.toMatchObject({ status: 422, message: 'ECONNREFUSED' });
  });

  it('returns status/body/available_paths for a successful test request', async () => {
    guardedFetchMock.mockResolvedValue(fakeGuardedFetchResult({ text: '{"id":1,"nested":{"tag":"x"}}' }));
    const { service } = newService();
    const result = await service.sendForTest('ws1', 'db1', 'rec1', 'user1', {
      type: 'http_request',
      method: 'GET',
      url: 'https://api.example.com/x',
    } as never);
    expect(result.status).toBe(200);
    expect(result.available_paths).toEqual(expect.arrayContaining(['id', 'nested.tag']));
  });
});
