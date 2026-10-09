import { TEMPLATE_INDUSTRIES } from '@storyos/schemas';

/**
 * Ticket #586 — the gallery filters on TWO independent axes: function category (agency, marketing,
 * creators, dev, people) and industry. `'all'` on an axis means "do not filter on it", so anyone who
 * ignores the industry row gets exactly the category filter they had before.
 */
export function filterTemplates<T extends { category: string; industry?: string }>(
  templates: T[],
  category: string,
  industry: string,
): T[] {
  return templates.filter(
    (t) => (category === 'all' || t.category === category) && (industry === 'all' || t.industry === industry),
  );
}

/**
 * The industry chips to offer: "All industries", then every industry that at least one template
 * carries, in the list's own order. An industry with no template would be a filter that always
 * answers "nothing", which the API test also refuses at the source.
 */
export function industryOptions(templates: Array<{ industry?: string }>): Array<{ value: string; label: string }> {
  const present = new Set(templates.map((t) => t.industry).filter((v): v is string => Boolean(v)));
  return [
    { value: 'all', label: 'All industries' },
    ...TEMPLATE_INDUSTRIES.filter((i) => present.has(i.value)).map((i) => ({ value: i.value, label: i.label })),
  ];
}
