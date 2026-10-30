// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLogger } from './log.js';
import { clearSecrets, forgetSecret, redact, registerSecret } from './redact.js';

beforeEach(() => clearSecrets());

describe('redaction', () => {
  it('masks a Runner token, a personal token and a bearer header by shape', () => {
    expect(redact('token mn_run_ABCDEFGHIJKLMNOP1234 here')).toBe('token [redacted] here');
    expect(redact('pat mn_pat_ABCDEFGHIJKLMNOP1234')).toBe('pat [redacted]');
    expect(redact('Authorization: Bearer abc.def-123_456')).toContain('[redacted]');
    expect(redact('{"token":"abcdef123456"}')).toBe('{"token":"[redacted]"}');
  });

  it('masks a registered value whatever it looks like, in any spelling of a code', () => {
    registerSecret('K7M2QX');
    expect(redact('typed k7m2qx then K7M2QX')).toBe('typed [redacted] then [redacted]');
    registerSecret('agt_RUNCRED_1234_xyz');
    expect(redact('cred agt_RUNCRED_1234_xyz used')).toBe('cred [redacted] used');
    forgetSecret('agt_RUNCRED_1234_xyz');
    expect(redact('cred agt_RUNCRED_1234_xyz used')).toBe('cred agt_RUNCRED_1234_xyz used');
  });

  it('leaves ordinary text alone, and ignores too-short secrets rather than mangling every line', () => {
    registerSecret('a');
    expect(redact('a plain sentence about agents')).toBe('a plain sentence about agents');
  });
});

describe('the log file', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'storyos-log-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('redacts every line before it reaches the disk or the echo, and is 0600', () => {
    registerSecret('PAIRCODE9');
    const echoed: string[] = [];
    const log = createFileLogger({ file: join(dir, 'logs', 'runner.log'), echo: (l) => echoed.push(l) });
    log.info('paired with code PAIRCODE9 and token mn_run_SECRETSECRETSECRET');
    log.error('boom Bearer topsecrettoken123');
    const text = readFileSync(join(dir, 'logs', 'runner.log'), 'utf8');
    for (const t of [text, echoed.join('\n')]) {
      expect(t).not.toContain('PAIRCODE9');
      expect(t).not.toContain('SECRETSECRET');
      expect(t).not.toContain('topsecrettoken123');
      expect(t).toContain('[redacted]');
    }
    expect(statSync(join(dir, 'logs', 'runner.log')).mode & 0o777).toBe(0o600);
  });

  it('rotates: a full file moves aside, a fixed number are kept, the oldest is dropped', () => {
    const file = join(dir, 'runner.log');
    const log = createFileLogger({ file, maxBytes: 200, keep: 3 });
    for (let i = 0; i < 40; i++) log.info(`line number ${i} ${'x'.repeat(40)}`);
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['runner.log', 'runner.log.1', 'runner.log.2', 'runner.log.3']);
    expect(existsSync(join(dir, 'runner.log.4'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('line number 39');
  });
});
