import { describe, expect, it } from 'vitest';
import { PACK_REGISTRY } from '../src/packs/registry';
import { PACK_PIPELINES, packWorkflow } from '../src/packs/pack-workflow';

describe('packWorkflow (#824)', () => {
  it('every pack in the registry has a workflow of at least two stages', () => {
    for (const entry of PACK_REGISTRY) {
      const wf = packWorkflow(entry);
      expect(wf, entry.slug).not.toBeNull();
      expect(wf!.stages.length, entry.slug).toBeGreaterThanOrEqual(2);
    }
  });

  // The card must say what installs: every label drawn is an option the manifest
  // really creates. This is what makes a renamed state fail here, not on a card.
  it('only draws states the manifest actually has', () => {
    for (const entry of PACK_REGISTRY) {
      const wf = packWorkflow(entry)!;
      const state = entry.manifest.states.find(
        (s) => s.database === wf.database && s.field === wf.field,
      )!;
      const options = state.options.map((o) => o.label);
      for (const label of wf.stages.flat())
        expect(options, `${entry.slug}: ${label}`).toContain(label);
    }
  });

  it('every pipeline override targets a pack that exists', () => {
    const slugs = new Set(PACK_REGISTRY.map((p) => p.slug));
    for (const slug of Object.keys(PACK_PIPELINES)) expect(slugs.has(slug), slug).toBe(true);
  });

  it('without an override, every option is a step in manifest order', () => {
    const content = PACK_REGISTRY.find((p) => p.slug === 'content-engine')!;
    expect(packWorkflow(content)!.stages).toEqual(
      ['Idea', 'Brief', 'Writing', 'Editing', 'Design', 'Ready', 'Published'].map((l) => [l]),
    );
  });

  it('drops exits that are not steps, and groups alternatives into one stage', () => {
    const bySlug = (s: string) => packWorkflow(PACK_REGISTRY.find((p) => p.slug === s)!)!.stages;
    expect(bySlug('support-inbox').flat()).not.toContain('Blocked');
    expect(bySlug('support-inbox').flat()).not.toContain('Canceled');
    expect(bySlug('dev-project-os').flat()).not.toContain('Canceled');
    expect(bySlug('consulting-os').at(-1)).toEqual(['Won', 'Lost']);
    expect(bySlug('coaching-os')).toEqual([
      ['Scheduled'],
      ['Done', 'No-show', 'Rescheduled', 'Canceled'],
    ]);
  });

  it('refuses a label the manifest does not contain, naming it', () => {
    const entry = { ...PACK_REGISTRY.find((p) => p.slug === 'support-inbox')! };
    PACK_PIPELINES['support-inbox'] = ['New', 'Reopened'];
    try {
      expect(() => packWorkflow(entry)).toThrow(/"Reopened"/);
    } finally {
      PACK_PIPELINES['support-inbox'] = ['New', 'To Do', 'In Progress', 'Review', 'Done'];
    }
  });
});
