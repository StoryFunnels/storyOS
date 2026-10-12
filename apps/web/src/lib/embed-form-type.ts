/**
 * #827 — the ONE source for how an embedded form's text and boxes are sized.
 *
 * The real public form (`app/f/[token]/page.tsx`) and the builder's theme preview
 * (`components/views/form-theme-preview.tsx`) BOTH build their title, description,
 * labels, controls, help text and submit button from these strings. They used to
 * restate the sizes independently, and drifted: the preview's title was 16px
 * against a 12px description while the real form's is 20px against 14px — so
 * someone tuning a theme judged emphasis and balance against a flatter form than
 * the one that ships. A preview's whole contract is "this is what you will get".
 *
 * Hand-syncing the numbers today would reproduce the defect with a longer fuse, so
 * the preview does not have its own numbers at all: change a role here and both
 * move. `embed-form-type.unit.test.ts` fails if either file starts carrying its
 * own copy of a size.
 *
 * Only TYPE and BOX METRICS live here (sizes, weights, padding, gaps) — the
 * properties that set the form's proportions. Colour comes from the theme tokens
 * the embed already resolves, which is why the preview is wrapped in the same
 * `embedThemeStyle`. Changing a value here changes the real embed, deliberately.
 */
export const EMBED_FORM = {
  /** Vertical rhythm between the header, each field and the submit button. */
  form: 'flex flex-col gap-5',
  title: 'text-xl font-semibold text-ink',
  description: 'mt-1 text-sm text-muted',
  /** A label, its control and its help text, stacked. */
  field: 'flex flex-col gap-1.5',
  label: 'text-body font-medium text-ink-secondary',
  control:
    'rounded-[var(--radius-control)] border border-border-strong bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent',
  help: 'text-label text-muted',
  submit:
    'mt-1 rounded-[var(--radius-control)] bg-primary px-4 py-2.5 text-sm font-medium text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-50',
} as const;
