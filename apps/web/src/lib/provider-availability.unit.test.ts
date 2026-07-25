import { describe, expect, it } from 'vitest';
import { presentAvailability } from './provider-availability';

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

  it('operator_config → non-actionable "Configured by your admin" hint with default copy', () => {
    const p = presentAvailability('operator_config');
    expect(p.state).toBe('operator_config');
    expect(p.actionable).toBe(false);
    expect(p.label).toBe('Configured by your admin');
    expect(p.description).toMatch(/admin/i);
  });

  it('server-provided availability_note overrides the default cloud_only copy', () => {
    const p = presentAvailability('cloud_only', '  Connect Meta Ads on StoryOS Cloud.  ');
    expect(p.description).toBe('Connect Meta Ads on StoryOS Cloud.');
  });

  it('a blank/whitespace note falls back to the default copy', () => {
    expect(presentAvailability('cloud_only', '   ').description).toMatch(/StoryOS Cloud/);
    expect(presentAvailability('operator_config', '').description).toMatch(/admin/i);
  });

  it('only connectable is actionable', () => {
    expect(presentAvailability('connectable').actionable).toBe(true);
    expect(presentAvailability('cloud_only').actionable).toBe(false);
    expect(presentAvailability('operator_config').actionable).toBe(false);
  });
});
