import { describe, expect, it } from 'vitest';
import { INTEGRATION_REGISTRY, SOCIAL_INGEST } from './integration-registry';

describe('integration registry — social ingest (#112)', () => {
  it('exposes Meta, X and LinkedIn as available gallery entries', () => {
    for (const id of ['meta', 'x', 'linkedin'] as const) {
      const entry = INTEGRATION_REGISTRY.find((d) => d.id === id);
      expect(entry, `missing registry entry: ${id}`).toBeDefined();
      expect(entry!.status).toBe('available');
    }
  });

  it('maps each platform to its source provider id', () => {
    expect(SOCIAL_INGEST.meta.sourceProvider).toBe('meta.page_comments');
    expect(SOCIAL_INGEST.x.sourceProvider).toBe('x.mentions');
    expect(SOCIAL_INGEST.linkedin.sourceProvider).toBe('linkedin.org_engagement');
  });

  it('recognizes a per-platform-named connection, not a generic one', () => {
    expect(SOCIAL_INGEST.meta.match.test('Meta comments')).toBe(true);
    expect(SOCIAL_INGEST.x.match.test('X mentions')).toBe(true);
    expect(SOCIAL_INGEST.linkedin.match.test('LinkedIn comments')).toBe(true);

    // A generic http connection is not claimed by any platform.
    for (const id of ['meta', 'x', 'linkedin'] as const) {
      expect(SOCIAL_INGEST[id].match.test('My API')).toBe(false);
    }
    // Platforms don't cross-match each other's default names.
    expect(SOCIAL_INGEST.meta.match.test('LinkedIn comments')).toBe(false);
    expect(SOCIAL_INGEST.linkedin.match.test('Meta comments')).toBe(false);
  });
});
