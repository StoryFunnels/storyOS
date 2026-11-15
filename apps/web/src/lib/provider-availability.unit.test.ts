import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectControl, presentAvailability } from './provider-availability';

describe('presentAvailability (#347 three honest states)', () => {
  it('connectable → actionable, no badge/description (uses existing connect controls)', () => {
    const p = presentAvailability('connectable');
    expect(p).toEqual({ state: 'connectable', actionable: true, label: '', description: '' });
  });

  it('cloud_only → non-actionable "Available on StoryOS Cloud" upsell with default copy', () => {
    const p = presentAvailability('cloud_only');
    expect(p.state).toBe('cloud_only');
    expect(p.actionable).toBe(false);
    expect(p.label).toBe('Available on StoryOS Cloud');
    expect(p.description).toMatch(/StoryOS Cloud/);
  });

  it('operator_config → non-actionable "Set up by the server operator" hint with default copy', () => {
    const p = presentAvailability('operator_config');
    expect(p.state).toBe('operator_config');
    expect(p.actionable).toBe(false);
    expect(p.label).toBe('Set up by the server operator');
    expect(p.description).toMatch(/runs this StoryOS server/);
  });

  // Ticket #1285: the viewer of this state IS the workspace admin, so "your admin" named the reader back to themselves. The person who
  // sets the env vars is the operator of the server. Held at the source of every place the state is worded, not just the helper.
  it('no wording of operator_config says "your admin" (the reader is the admin; the operator sets the env vars)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ['provider-availability.ts', '../components/settings/provider-card.tsx', 'connection-card.ts']) {
      expect(readFileSync(join(here, f), 'utf8'), f).not.toMatch(/your admin|Configured by your admin/);
    }
    expect(presentAvailability('operator_config').label).not.toMatch(/admin/i);
    expect(presentAvailability('operator_config').description).not.toMatch(/admin/i);
  });

  it('what must be KEPT: a server note still overrides cloud_only, and operator_config offers no action', () => {
    expect(presentAvailability('cloud_only', 'x').description).toBe('x');
    expect(presentAvailability('operator_config').actionable).toBe(false);
  });

  it('server-provided availability_note overrides the default cloud_only copy', () => {
    const p = presentAvailability('cloud_only', '  Connect Meta Ads on StoryOS Cloud.  ');
    expect(p.description).toBe('Connect Meta Ads on StoryOS Cloud.');
  });

  it('a blank/whitespace note falls back to the default copy', () => {
    expect(presentAvailability('cloud_only', '   ').description).toMatch(/StoryOS Cloud/);
    expect(presentAvailability('operator_config', '').description).toMatch(/runs this StoryOS server/);
  });

  it('only connectable is actionable', () => {
    expect(presentAvailability('connectable').actionable).toBe(true);
    expect(presentAvailability('cloud_only').actionable).toBe(false);
    expect(presentAvailability('operator_config').actionable).toBe(false);
  });
});

describe('connectControl (#348 — Tier B never gets per-user key entry)', () => {
  it('a connectable oauth_managed (oauth2) provider is routed to OAuth, never a key form', () => {
    expect(connectControl('connectable', 'oauth2', 'google')).toBe('oauth');
    expect(connectControl('connectable', 'oauth2', 'google-calendar')).toBe('oauth');
  });

  it('an oauth2 provider is NEVER routed to the api-key entry control, in any state', () => {
    for (const availability of ['connectable', 'operator_config', 'cloud_only'] as const) {
      expect(connectControl(availability, 'oauth2', 'google')).not.toBe('api-key');
    }
  });

  it('a non-connectable provider surfaces no connect control at all', () => {
    // operator_config is exactly the self-managed Tier B "env unset" state: the
    // gallery must not render a connect entry, instructional wall, or key form.
    expect(connectControl('operator_config', 'oauth2', 'google')).toBe('none');
    expect(connectControl('operator_config', 'api_key', 'apify')).toBe('none');
    expect(connectControl('cloud_only', 'oauth2', 'google')).toBe('none');
  });

  it('Tier A api_key providers keep their per-user key entry when connectable', () => {
    expect(connectControl('connectable', 'api_key', 'apify')).toBe('api-key');
    expect(connectControl('connectable', 'api_key', 'resend')).toBe('api-key');
    expect(connectControl('connectable', 'smtp', 'smtp')).toBe('api-key');
    expect(connectControl('connectable', 'api_key', 'http')).toBe('http');
  });
});
