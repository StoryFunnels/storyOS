import { TEMPLATE_INDUSTRIES } from '@storyos/schemas';
import { describe, expect, it } from 'vitest';
import { filterTemplates, industryOptions } from './template-filter';

const t = (slug: string, category: string, industry?: string) => ({ slug, category, industry });
const all = [
  t('a', 'agency', 'agencies'),
  t('b', 'agency', 'general'),
  t('c', 'marketing', 'media'),
  t('d', 'marketing', 'general'),
  t('e', 'dev', 'software'),
];

describe('filterTemplates (ticket #586)', () => {
  it('"all" on both axes returns everything', () => {
    expect(filterTemplates(all, 'all', 'all')).toHaveLength(5);
  });
  it('the category filter is unchanged for anyone who ignores the industry axis', () => {
    expect(filterTemplates(all, 'agency', 'all').map((x) => x.slug)).toEqual(['a', 'b']);
    expect(filterTemplates(all, 'marketing', 'all').map((x) => x.slug)).toEqual(['c', 'd']);
  });
  it('industry filters independently of category', () => {
    expect(filterTemplates(all, 'all', 'general').map((x) => x.slug)).toEqual(['b', 'd']);
    expect(filterTemplates(all, 'all', 'software').map((x) => x.slug)).toEqual(['e']);
  });
  it('the two axes intersect, and an empty intersection is empty', () => {
    expect(filterTemplates(all, 'marketing', 'general').map((x) => x.slug)).toEqual(['d']);
    expect(filterTemplates(all, 'dev', 'media')).toEqual([]);
  });
  it('a template with no industry (an older API) still shows under "all industries" and is never silently dropped from it', () => {
    const legacy = [t('x', 'agency')];
    expect(filterTemplates(legacy, 'agency', 'all')).toHaveLength(1);
    expect(filterTemplates(legacy, 'agency', 'general')).toEqual([]);
  });
});

describe('industryOptions', () => {
  it('starts with "All industries" and lists only industries some template carries, in the shared order', () => {
    expect(industryOptions(all).map((o) => o.value)).toEqual(['all', 'general', 'agencies', 'media', 'software']);
  });
  it('labels come from the shared list', () => {
    const labels = new Map(TEMPLATE_INDUSTRIES.map((i) => [i.value, i.label]));
    for (const o of industryOptions(all).slice(1)) expect(o.label).toBe(labels.get(o.value as never));
  });
});
