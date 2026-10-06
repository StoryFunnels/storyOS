/**
 * #801 — the "type this name to confirm" prompt, ONE implementation for every typed
 * confirmation (delete space, delete database, erase member).
 *
 * The name is the one string the person must reproduce, so it must be copyable. It
 * is therefore never inside a <label>: a label's click moves focus to its control,
 * which collapses a drag-selection of the label's own text — measured live, a drag
 * across the name left an empty selection with focus in the input. And it is on
 * its OWN line: a triple-click on a sentence copies the sentence ("Type X to
 * confirm"), which can never match. `select-all` makes one click select exactly
 * the name. Callers name their <Input> with aria-label instead of a wrapping label.
 *
 * Three dialogs each wrote this by hand and drifted: one nested the name in a
 * label, one kept it inside a sentence, one used `htmlFor` and called it fixed.
 */
export function TypedConfirmName({ name }: { name: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-body text-ink-secondary">Type this name to confirm:</p>
      <p className="break-words rounded-[var(--radius-control)] bg-hover px-2 py-1 text-body font-medium text-ink select-all">
        {name}
      </p>
    </div>
  );
}
