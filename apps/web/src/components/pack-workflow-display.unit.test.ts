import { describe, expect, it } from 'vitest';
import { heroChips, packHueName, workflowSentence } from './pack-workflow-display';
import { OPTION_COLORS } from './table-view/option-colors';

const seq = (...l: string[]) => l.map((x) => [x]);

describe('heroChips', () => {
  it('draws a short pipeline in full, with the last chip marked as the end', () => {
    const chips = heroChips(seq('Outline', 'Draft', 'Revised', 'Final'));
    expect(chips.map((c) => (c.kind === 'step' ? c.label : '+'))).toEqual(['Outline', 'Draft', 'Revised', 'Final']);
    expect(chips.filter((c) => c.kind === 'step' && c.end)).toHaveLength(1);
  });

  // Content Engine, the longest in the registry: seven states must not change the card height.
  it('elides the middle of a long pipeline and says how many are hidden', () => {
    const chips = heroChips(seq('Idea', 'Brief', 'Writing', 'Editing', 'Design', 'Ready', 'Published'));
    expect(chips).toHaveLength(5);
    expect(chips[2]).toEqual({ kind: 'more', hidden: 3 });
    expect(chips[0]).toMatchObject({ label: 'Idea' });
    expect(chips[4]).toMatchObject({ label: 'Published', end: true });
  });

  it('five stages is the most that is shown in full', () => {
    expect(heroChips(seq('a', 'b', 'c', 'd', 'e'))).toHaveLength(5);
    expect(heroChips(seq('a', 'b', 'c', 'd', 'e')).some((c) => c.kind === 'more')).toBe(false);
    expect(heroChips(seq('a', 'b', 'c', 'd', 'e', 'f')).some((c) => c.kind === 'more')).toBe(true);
  });

  // Alternatives keep their OWN mark and are never counted as hidden steps.
  it('collapses alternatives onto their first label as "/ +N", not as hidden steps', () => {
    const chips = heroChips([['Draft'], ['Sent'], ['Negotiating'], ['Won', 'Lost']]);
    expect(chips).toHaveLength(4);
    expect(chips[3]).toEqual({ kind: 'step', label: 'Won', alt: 1, end: true });
    const coaching = heroChips([['Scheduled'], ['Done', 'No-show', 'Rescheduled', 'Canceled']]);
    expect(coaching[1]).toMatchObject({ label: 'Done', alt: 3 });
    expect(coaching.some((c) => c.kind === 'more')).toBe(false);
  });

  it('an empty workflow draws nothing rather than crashing', () => {
    expect(heroChips([])).toEqual([]);
  });
});

describe('workflowSentence', () => {
  it('says the whole thing, with nothing elided', () => {
    expect(workflowSentence([['Draft'], ['Won', 'Lost']])).toBe('Draft, then Won or Lost');
  });
});

describe('packHueName', () => {
  it('always names a real chip colour, pinned or not', () => {
    for (const slug of ['agency-os', 'coaching-os', 'some-community-pack', '', 'x'.repeat(200)]) {
      expect(OPTION_COLORS[packHueName(slug)], slug).toBeDefined();
    }
  });

  it('is stable for a slug', () => {
    expect(packHueName('community-thing')).toBe(packHueName('community-thing'));
  });

  it('keeps the eight built-ins apart', () => {
    const slugs = ['agency-os', 'content-engine', 'dev-project-os', 'consulting-os', 'book-launch', 'support-inbox', 'client-portal', 'coaching-os'];
    expect(new Set(slugs.map(packHueName)).size).toBe(8);
  });
});
