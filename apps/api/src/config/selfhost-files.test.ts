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

  describe('a plain copy logs mail instead of calling a mail provider (#1337)', () => {
    // The quickstart supplies no mail provider. `RESEND_API_KEY=re_your_resend_api_key_here` made the API call Resend with a fake
    // key at every sign-up (401, user left unverified, nothing in the UI). So a plain copy must carry NO active key,
    // and no active sender address on somebody else's domain.
    it('.env.example ships no active RESEND_API_KEY value', () => {
      expect(envExample).toMatch(/^RESEND_API_KEY=$/m);
      expect(envExample).not.toMatch(/^RESEND_API_KEY=\S/m);
    });

    it('.env.example does not pin MAIL_FROM to an address on a domain the self-hoster does not own', () => {
      expect(envExample).not.toMatch(/^MAIL_FROM=.*@storyos\.dev/m);
      expect(envExample).not.toMatch(/^MAIL_FROM=/m);
    });

    it('no active SMTP_HOST either, so the log driver is what runs', () => {
      expect(envExample).not.toMatch(/^SMTP_HOST=\S/m);
    });

    it("the file says that blank means 'logged, not sent', and where to find the link", () => {
      const email = envExample.slice(envExample.indexOf('# --- Email'), envExample.indexOf('# --- Object storage'));
      expect(email).toMatch(/logged/i);
      expect(email).toMatch(/docker compose logs api/);
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

    it('the quickstart documents the create-workspace step, the cold build and the real status of mcp (#1337)', () => {
      for (const [name, doc] of [['overview', overview], ['repoDoc', repoDoc]] as const) {
        expect(doc, `${name}: Create your workspace`).toMatch(/Create\s+your\s+workspace/);
        expect(doc, `${name}: cold build`).toMatch(/builds? three images/i);
        expect(doc, `${name}: from source`).toMatch(/from source/i);
        expect(doc, `${name}: build time`).toMatch(/\d+\s*(-|to|–)?\s*\d*\s*minutes/i);
        expect(doc, `${name}: confirmation mail logged`).toMatch(/docker compose logs api/);
      }
    });

    // mcp stays in the default set on purpose: docker-compose.prod.yml overrides its image and the production deploy runs
    // `docker compose up -d`, so a profile would silently stop deploying it. The docs therefore say it starts by default.
    it('mcp is not called optional while `docker compose up -d` builds and starts it (#1337)', () => {
      const mcpBlock = /^ {2}mcp:\n((?: {3,}.*\n|\s*#.*\n|\n)*)/m.exec(compose)?.[1] ?? '';
      expect(mcpBlock, 'could not find the mcp service block').toContain('image: storyos-mcp:latest');
      expect(mcpBlock).not.toMatch(/^ {4}profiles:/m);
      expect(overview).not.toMatch(/\*\*mcp\*\* \*\(optional\)\*/);
      expect(overview).toMatch(/docker compose up -d caddy/);
      expect(repoDoc).toMatch(/docker compose up -d caddy/);
    });

    it('the default URLs are documented as http://localhost, with the HTTP_PORT caveat', () => {
      for (const doc of [configuration, repoDoc]) {
        expect(doc).not.toContain('`http://localhost:3001` / `:3000`');
        expect(doc).toMatch(/HTTP_PORT/);
      }
    });
  });
});
