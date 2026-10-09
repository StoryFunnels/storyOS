/**
 * Ticket #586 — the industry axis of the template gallery, beside the existing function categories
 * (agency / marketing / creators / dev / people). One list, shared by the API (which tags every
 * template with exactly one value) and the web gallery (which labels and filters by it), so the two
 * cannot drift.
 *
 * THE LIST IS A CONTENT DECISION, deliberately small and drawn from what the 23 shipped templates
 * actually are rather than from a market taxonomy (Baserow/NocoDB carry 14-25): an industry with no
 * template under it would be an empty filter. `general` is the explicit answer for a template that is
 * useful in any industry (a CRM, a calendar, an org chart) — never a blank. Adding a vertical means
 * adding it here, tagging at least one template, and the API test fails until both are true.
 */
export const TEMPLATE_INDUSTRIES = [
  { value: 'general', label: 'Cross-industry' },
  { value: 'agencies', label: 'Agencies & studios' },
  { value: 'professional-services', label: 'Coaching & consulting' },
  { value: 'media', label: 'Media & creators' },
  { value: 'software', label: 'Software & IT' },
  { value: 'events', label: 'Events' },
] as const;

export type TemplateIndustry = (typeof TEMPLATE_INDUSTRIES)[number]['value'];
