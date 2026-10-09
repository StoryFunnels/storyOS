import { EMBED_FORM } from '@/lib/embed-form-type';

/**
 * #827 — the form-theme panel's preview: a miniature of the embedded form, built
 * from the SAME type and box metrics as the real public form
 * (`lib/embed-form-type.ts`), so the title-to-body proportion here IS the one that
 * ships. This file deliberately contains no font-size or spacing classes of its
 * own — `embed-form-type.unit.test.ts` fails if one appears.
 *
 * Colours resolve through the theme tokens of whatever element wraps it (the
 * panel wraps it in `embedThemeStyle`, exactly as the public page does).
 * It is a faithful miniature, not a live copy of the form: the real renderer
 * needs a public token, a fetch and a record write.
 */
export function EmbedFormPreview() {
  return (
    <div className={EMBED_FORM.form}>
      <div>
        <h4 className={EMBED_FORM.title}>Your form</h4>
        <p className={EMBED_FORM.description}>A short description under the title.</p>
      </div>
      <div className={EMBED_FORM.field}>
        <span className={EMBED_FORM.label}>Email</span>
        {/* A real control's box, with a line of text height inside it, so its
            height comes from the same padding and line-height as the embed's. */}
        <div className={EMBED_FORM.control} aria-hidden>
          &nbsp;
        </div>
        <span className={EMBED_FORM.help}>Help text under the field.</span>
      </div>
      <div className={`${EMBED_FORM.submit} text-center`}>Submit</div>
    </div>
  );
}
