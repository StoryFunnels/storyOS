import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDER_PAGES } from './provider-pages';
import { OWN_SETUP_PAGES, providersWithSetup, setupDisclosure } from './setup-disclosure';

/** Ticket #1221 — a connected provider page leads with the card; setup is closed behind one disclosure, and open when not connected. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const pageSource = (id: string): string | null => {
  if (id === 'meta' || id === 'x' || id === 'linkedin') return read('../components/social-ingest-setup.tsx');
  const rel = `../app/w/[ws]/settings/integrations/${id}/page.tsx`;
  return existsSync(fileURLToPath(new URL(rel, import.meta.url))) ? read(rel) : null;
};

describe('setupDisclosure: connected collapses, not connected stays open', () => {
  for (const def of PROVIDER_PAGES.filter((p) => p.backing.kind !== 'builtin')) {
    it(`${def.id}: connected -> one closed disclosure titled for the provider; not connected -> open`, () => {
      const on = setupDisclosure(def.label, true);
      expect(on.collapsed).toBe(true);
      expect(on.title).toBe(`Change how ${def.label} is connected`);
      expect(setupDisclosure(def.label, false).collapsed).toBe(false);
    });
  }
});

describe('every provider page with setup content wraps it in the disclosure', () => {
  it('the set is exactly the registry providers that have their own page folder (or the social platforms)', () => {
    for (const def of PROVIDER_PAGES.filter((p) => p.backing.kind !== 'builtin')) {
      const has = pageSource(def.id) !== null;
      expect(OWN_SETUP_PAGES.has(def.id), `${def.id} own page: ${has}`).toBe(has);
    }
  });

  for (const def of providersWithSetup()) {
    it(`${def.id}: the page renders <SetupDisclosure> and no bare setup guide`, () => {
      const src = pageSource(def.id)!;
      expect(src).toContain('<SetupDisclosure');
      // The stepper must sit inside the disclosure: the first guide comes after the disclosure opens, never before it.
      expect(src.indexOf('<SetupDisclosure')).toBeLessThan(src.indexOf('<IntegrationSetupGuide'));
    });
  }

  it('GitHub: the token form and the App box are inside; the card and the not-tracked list are outside, before it', () => {
    const src = pageSource('github')!;
    const open = src.indexOf('<SetupDisclosure');
    const close = src.indexOf('</SetupDisclosure>');
    expect(src.indexOf('Connect the GitHub App')).toBeGreaterThan(open);
    expect(src.indexOf('Connect the GitHub App')).toBeLessThan(close);
    expect(src.indexOf('Or use a personal access token')).toBeLessThan(close);
    expect(src.indexOf('<GithubUntracked')).toBeLessThan(open);
  });

  it("Linear: the stepper and '1. Key and teams' share ONE disclosure", () => {
    const src = pageSource('linear')!;
    expect(src.match(/<SetupDisclosure/g)).toHaveLength(1);
    const open = src.indexOf('<SetupDisclosure');
    const close = src.indexOf('</SetupDisclosure>');
    expect(src.indexOf('title="Key and teams"')).toBeGreaterThan(open);
    expect(src.indexOf('title="Key and teams"')).toBeLessThan(close);
  });
});
