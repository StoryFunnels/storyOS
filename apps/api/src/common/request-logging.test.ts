import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { pinoHttp } from 'pino-http';
import { redactUrl, requestLogRedaction } from './request-logging';

/**
 * #1078 — drive the real pino-http options app.module.ts uses through a real
 * HTTP request and read the line it writes, so the test fails if the
 * serializer is not wired (not just if redactUrl is wrong).
 */
async function logLineFor(path: string, headers: Record<string, string> = {}): Promise<string> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const logger = pinoHttp({ ...requestLogRedaction, level: 'info' }, sink);
  const server = createServer((req, res) => {
    logger(req, res);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).text();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return lines.join('');
}

describe('request log redaction (#1078)', () => {
  it.each([
    ['/api/v1/auth/reset-password/RESETTOKEN123?callbackURL=https%3A%2F%2Fapp', 'RESETTOKEN123'],
    ['/api/v1/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.JWTPAYLOAD.SIG', 'JWTPAYLOAD'],
    ['/api/v1/files/f1/download?expires=1800000000&sig=SIGNATUREVALUE', 'SIGNATUREVALUE'],
    ['/api/v1/public/views/SHARETOKEN42', 'SHARETOKEN42'],
    ['/api/v1/public/forms/FORMTOKEN42/relations/fld_1', 'FORMTOKEN42'],
    ['/api/v1/connections/oauth/callback?code=OAUTHCODE&state=STATEVALUE', 'OAUTHCODE'],
  ])('a credential in %s never reaches the log', async (path, secret) => {
    const line = await logLineFor(path);
    expect(line).toContain('"url"');
    expect(line).not.toContain(secret);
  });

  it('keeps what a log line is for: the route, the parameter names, and the header censor', async () => {
    const line = await logLineFor('/api/v1/files/f1/download?expires=1&sig=abc', {
      authorization: 'Bearer mn_pat_SECRET',
    });
    expect(line).toContain('/api/v1/files/f1/download?expires=[redacted]&sig=[redacted]');
    expect(line).not.toContain('mn_pat_SECRET');
  });

  it('leaves an ordinary path untouched', () => {
    expect(redactUrl('/api/v1/workspaces/ws_1/databases/db_1/records')).toBe(
      '/api/v1/workspaces/ws_1/databases/db_1/records',
    );
    expect(redactUrl('/api/v1/public/forms/[redacted]/relations/fld_1')).toBe(
      '/api/v1/public/forms/[redacted]/relations/fld_1',
    );
  });
});
