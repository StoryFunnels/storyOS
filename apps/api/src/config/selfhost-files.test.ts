import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ticket #1286. The self-host quickstart is `cp .env.example .env`, one generate
// step, `docker compose up -d`, then sign up at http://localhost. Theo's timed
// run found it broken twice: compose refused a variable that .env.example never
// mentioned, and the default WEB_URL was a port the stack does not serve on.
// These read the real files so the three (compose, .env.example, docs) cannot
// drift apart again without a failing test.
const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const compose = read('docker-compose.yml');
const envExample = read('.env.example');

/** Variables compose refuses to start without (`${NAME:?message}`). */
function requiredByCompose(): { name: string; message: string }[] {
  return [...compose.matchAll(/^\s+[A-Z_]+: \$\{([A-Z_]+):\?([^}]*)\}/gm)].map((m) => ({
    name: m[1]!,
    message: m[2]!,
  }));
}

function envExampleKeys(): string[] {
  return envExample
    .split('\n')
    .map((l) => /^([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((k): k is string => Boolean(k));
}

describe('self-host quickstart files (#1286)', () => {
  it('compose requires exactly the secrets the quickstart generates', () => {
    expect(
      requiredByCompose()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['BETTER_AUTH_SECRET', 'CONNECTIONS_MASTER_KEY']);
  });

  it('every variable compose requires is listed in .env.example', () => {
    for (const { name } of requiredByCompose()) {
      expect(envExampleKeys(), `${name} missing from .env.example`).toContain(name);
    }
  });

  it('every required variable is documented with its generate command in .env.example', () => {
    for (const { name } of requiredByCompose()) {
      const at = envExample.indexOf(`\n${name}=`);
      const preceding = envExample.slice(Math.max(0, at - 400), at);
      expect(preceding, `${name} has no generate hint above it`).toMatch(/openssl rand -hex 32/);
    }
  });

  it("compose's own missing-variable error names the variable and how to generate it", () => {
    for (const { name, message } of requiredByCompose()) {
      expect(message).toContain(name);
      expect(message).toMatch(/openssl rand -hex 32/);
    }
  });

  it('the shipped .env.example leaves the secrets blank (a real value must never be committed)', () => {
    for (const { name } of requiredByCompose()) {
      expect(envExample).toMatch(new RegExp(`^${name}=$`, 'm'));
    }
  });

  describe('origin defaults match the port the stack serves on', () => {
    // Caddy publishes HTTP_PORT (default 80) and serves web + api on that one
    // origin. A browser at http://localhost sends `Origin: http://localhost`,
    // and auth trusts exactly WEB_URL.
    it('caddy serves on port 80 by default', () => {
      expect(compose).toContain("'${HTTP_PORT:-80}:80'");
    });

    it('every WEB_URL and API_URL default in compose is the port-80 origin', () => {
      const defaults = [...compose.matchAll(/^\s+(WEB_URL|API_URL): \$\{\1:-([^}]*)\}/gm)];
      expect(defaults.length).toBeGreaterThanOrEqual(4); // api, web build arg, web, mcp
      for (const [, name, value] of defaults) {
        expect(value, `${name} default`).toBe('http://localhost');
      }
    });

    it('.env.example copies straight to a working localhost install', () => {
      expect(envExample).toMatch(/^WEB_URL=http:\/\/localhost$/m);
      expect(envExample).toMatch(/^API_URL=http:\/\/localhost$/m);
    });
  });

  describe('docs match the files', () => {
    const overview = read('apps/docs/src/content/docs/self-hosting/overview.md');
    const configuration = read('apps/docs/src/content/docs/self-hosting/configuration.md');
    const repoDoc = read('docs/self-hosting.md');

    it('the quickstart copies .env.example and generates both secrets', () => {
      const quickstart = overview.slice(
        overview.indexOf('## Quickstart'),
        overview.indexOf('## What'),
      );
      expect(quickstart).toContain('cp .env.example .env');
      expect(quickstart).toContain('BETTER_AUTH_SECRET');
      expect(quickstart).toContain('CONNECTIONS_MASTER_KEY');
    });

    it('no doc claims CONNECTIONS_MASTER_KEY can be left unset', () => {
      for (const doc of [overview, configuration, repoDoc]) {
        expect(doc).not.toMatch(/can leave it unset/i);
      }
      expect(configuration).toContain('CONNECTIONS_MASTER_KEY');
      expect(repoDoc).toMatch(
        /Only `BETTER_AUTH_SECRET` and `CONNECTIONS_MASTER_KEY` are required/,
      );
    });

    it('the default URLs are documented as http://localhost, with the HTTP_PORT caveat', () => {
      for (const doc of [configuration, repoDoc]) {
        expect(doc).not.toContain('`http://localhost:3001` / `:3000`');
        expect(doc).toMatch(/HTTP_PORT/);
      }
    });
  });
});
