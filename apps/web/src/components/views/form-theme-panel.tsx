'use client';

import { useMemo } from 'react';
import type { ViewConfig } from './use-view-state';
import {
  COMFORTABLE_CONTRAST,
  contrastRatio,
  embedThemeStyle,
  readableTextFor,
} from '@/lib/embed-theme';

type Theme = NonNullable<NonNullable<ViewConfig['form']>['theme']>;

/**
 * #711 phase 2 — "Match your site", the builder for an embedded form's theme.
 *
 * WHY THE LIVE PREVIEW IS THE FEATURE, not a nicety. AC4 says an embedder must
 * never hand-write config; giving them four colour slots and no preview obeys
 * the letter and breaks the spirit, because nobody can hold four tokens in
 * their head and predict a form. Everything else here is in service of the box
 * at the bottom updating as you drag.
 *
 * The preview resolves through the SAME tokens the real form does — it is
 * wrapped in `embedThemeStyle(theme)`, the identical function the public page
 * applies — so what moves here is what moves there. It is a faithful miniature
 * rather than a live copy of the form itself: the real renderer needs a public
 * token, a fetch and a record write, none of which belong in a settings panel.
 * The honest limit of that is stated in the PR rather than implied here.
 */
export function FormThemePanel({
  theme,
  onChange,
}: {
  theme: Theme | undefined;
  onChange: (next: Theme | undefined) => void;
}) {
  // Defaults shown in the pickers are today's OWN values, so opening the panel
  // never changes anything. Absent config still emits nothing (spec §2) —
  // `theme` stays undefined until a control is actually touched.
  const accent = theme?.accent ?? '#0f1729';
  const surface = theme?.surface ?? '#ffffff';
  const text = theme?.text ?? '#1c1917';
  const radius = theme?.radius ?? 6;

  const set = (patch: Partial<Theme>) => onChange({ ...(theme ?? {}), ...patch });

  const ratio = useMemo(() => contrastRatio(text, surface), [text, surface]);
  const uncomfortable = ratio < COMFORTABLE_CONTRAST;
  const style = useMemo(() => embedThemeStyle(theme) ?? undefined, [theme]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Match your site</p>
        {theme && (
          <button
            type="button"
            className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
            /* Spec §4 of the panel: reset must return to today's appearance
               EXACTLY. Clearing to undefined does that by construction —
               "default" means "emit nothing", so there is no set of values to
               restore and no drift between the default and the reset. */
            onClick={() => onChange(undefined)}
          >
            Reset to default
          </button>
        )}
      </div>

      <p className="text-[12px] text-muted">
        Applies to the embedded form only. Your own copy of the form is unchanged.
      </p>

      <Swatch label="Accent" hint="button, links, focus ring" value={accent} onChange={(v) => set({ accent: v })} />
      <Swatch label="Surface" hint="input backgrounds" value={surface} onChange={(v) => set({ surface: v })} />
      <Swatch label="Text" hint="headings and labels" value={text} onChange={(v) => set({ text: v })} />

      <label className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-muted">Corners</span>
        <input
          type="range"
          min={0}
          max={16}
          step={1}
          value={radius}
          onChange={(e) => set({ radius: Number(e.target.value) })}
          className="h-1 flex-1 accent-[var(--primary)]"
          aria-label="Corner radius"
        />
        <span className="w-10 shrink-0 tabular-nums text-muted">{radius}px</span>
      </label>

      {uncomfortable && (
        /* Spec: the contrast warning is a PRODUCT FEATURE, not a lint. Our form
           looking broken on a customer's site is our problem regardless of who
           picked the colours — so this offers the correction rather than just
           naming the fault. */
        <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-border-default bg-hover p-2">
          <span className="text-[12px] text-ink">
            Text and Surface are close — {ratio.toFixed(1)}:1. Small labels will be hard to read.
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded-[var(--radius-control)] border border-border-default px-2 py-0.5 text-[12px] text-ink hover:bg-card"
            onClick={() => set({ text: readableTextFor(text, surface) })}
          >
            Fix for me
          </button>
        </div>
      )}

      <div className="rounded-[var(--radius-control)] border border-border-default p-3" style={style}>
        <p className="mb-2 text-[11px] uppercase tracking-wider text-muted">Preview</p>
        <div className="flex flex-col gap-2 text-[13px]">
          <span className="text-[15px] font-semibold text-ink">Your form</span>
          <span className="text-[12px] text-muted">A short description under the title.</span>
          <span className="text-[12px] font-medium text-ink-secondary">Email</span>
          <div className="h-8 rounded-[var(--radius-control)] border border-border-strong bg-card" />
          <span className="text-[11px] text-muted">Help text under the field.</span>
          <div className="mt-1 rounded-[var(--radius-control)] bg-primary px-3 py-1.5 text-center text-[13px] font-medium text-[var(--text-on-dark)]">
            Submit
          </div>
        </div>
      </div>
    </section>
  );
}

/** A colour row: the native picker for choosing, a hex box for pasting a brand value. */
function Swatch({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border-default bg-card"
        aria-label={`${label} colour`}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-7 w-24 shrink-0 rounded-[var(--radius-control)] border border-border-default bg-card px-2 font-mono text-[12px] text-ink"
        aria-label={`${label} hex`}
      />
      {/* Spec: each control says what it affects. Four abstract colour slots
          are four guesses otherwise. */}
      <span className="truncate text-[12px] text-muted">{hint}</span>
    </label>
  );
}
