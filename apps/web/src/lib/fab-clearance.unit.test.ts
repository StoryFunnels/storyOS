import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAB_CLEARANCE_PB } from './fab-clearance';

// #1120 — source guard. The clearance is derived from the button's own classes, so resizing or moving
// the button without updating the clearance fails here instead of silently covering a row again.
const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const SPACING = 4; // Tailwind spacing unit, px

describe('FAB clearance (#1120)', () => {
  const fab = src('components/quick-add-fab.tsx');
  const cls = /className="(fixed [^"]*Quick[^"]*|fixed bottom-[^"]*)"/.exec(fab)?.[1] ?? '';

  it('reads the button geometry it protects', () => {
    expect(cls).toMatch(/\bbottom-(\d+)\b/);
    expect(cls).toMatch(/\bh-(\d+)\b/);
    expect(cls).toMatch(/\bmd:hidden\b/);
  });

  it('is taller than offset + button, so the last row ends above the button', () => {
    const bottom = Number(/\bbottom-(\d+)\b/.exec(cls)![1]) * SPACING;
    const height = Number(/\bh-(\d+)\b/.exec(cls)![1]) * SPACING;
    const pb = Number(/\bpb-(\d+)\b/.exec(FAB_CLEARANCE_PB)![1]) * SPACING;
    expect(pb).toBeGreaterThan(bottom + height);
  });

  it('applies on phones only, matching the button md:hidden', () => {
    expect(FAB_CLEARANCE_PB).toMatch(/\bmd:pb-\d+\b/);
  });

  it('the list view scroll region uses it (the one place the ticket reproduced)', () => {
    expect(src('components/views/list-view.tsx')).toContain('FAB_CLEARANCE_PB');
  });
});
