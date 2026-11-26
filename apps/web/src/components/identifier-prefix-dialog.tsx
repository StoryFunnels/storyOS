'use client';

import { useState } from 'react';
import { identifierPrefixDraft, identifierPrefixHelper } from '@/lib/identifier-prefix-draft';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The API's refusal as the web client receives it (`unwrap` throws the response body): `{ message }` or `{ error: { message } }`. */
export function apiErrorMessage(error: unknown): string | null {
  const e = error as { message?: unknown; error?: { message?: unknown } } | null;
  const m = e?.error?.message ?? e?.message;
  return typeof m === 'string' && m.trim() ? m : null;
}

/**
 * Ticket #1381 — set or clear a database's identifier prefix (`ISSUE` → records read `ISSUE-123`). Admin only; the caller does not
 * render it for anyone else, and the API refuses a non-admin regardless.
 *
 * `onSave` returns the save as a promise so a refusal (duplicate prefix 409, bad shape 422, not-an-admin 403) lands INLINE under the box,
 * in the API's own words, and the dialog stays open. The shape check before the round trip is `identifierPrefixDraft`, which imports the
 * API's schema; uniqueness cannot be known here, so it is the server's answer that is shown.
 */
export function IdentifierPrefixDialogContent({
  name,
  initial,
  onSave,
}: {
  name: string;
  initial: string | null | undefined;
  /** Resolves when saved (the caller closes the dialog), rejects with the API error. */
  onSave: (prefix: string | null) => Promise<unknown>;
}) {
  const [value, setValue] = useState(initial ?? '');
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = identifierPrefixDraft(value, initial);
  const error = serverError ?? draft.error;

  return (
    <DialogContent title={`Identifier prefix for ${name}`} unsaved={!draft.unchanged}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (draft.error || draft.unchanged || saving) return;
          setSaving(true);
          setServerError(null);
          try {
            await onSave(draft.value);
          } catch (err) {
            setServerError(apiErrorMessage(err) ?? 'Could not save the identifier prefix');
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-body text-muted">Identifier prefix</span>
          <Input
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value.toUpperCase());
              setServerError(null);
            }}
            placeholder="ISSUE"
            spellCheck={false}
            autoCapitalize="characters"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby="identifier-prefix-help"
            data-testid="identifier-prefix-input"
            className={cn('w-full font-mono', error && 'border-error')}
          />
        </label>
        {error ? (
          <p id="identifier-prefix-help" role="alert" className="text-label text-error" data-testid="identifier-prefix-error">
            {error}
          </p>
        ) : (
          <p id="identifier-prefix-help" className="text-label text-muted">
            {identifierPrefixHelper(draft)}
          </p>
        )}
        <div className="flex items-center gap-2">
          <div className="ml-auto flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={Boolean(draft.error) || draft.unchanged || saving}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  );
}
