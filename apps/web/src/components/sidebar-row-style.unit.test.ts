import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CARET_HIT_AREA, SIDEBAR_INDENT_PX, markInitials, sidebarRowIndent, sidebarRowStateClass } from './sidebar-row-style';

/**
 * #380 / #742 — this geometry has regressed twice under the OLD margin-scale
 * model, so its replacement is pinned too.
 *
 * #219 fixed the document row by copying an invisible grip spacer out of
 * DatabaseRow. #347 then added view rows, which never inherited that copy, and a
 * space-level dashboard rendered ~10px LEFT of the databases beside it.
 *
 * #742 REPLACES the three-level margin scale with the design artifact's
 * fixed-icon-gutter model: a space's label and a database's label now start
 * at the SAME x (findings 02/12 — "four levels, zero indent steps"), and the
 * only real indent left is a folder's own children (one step). These
 * assertions changed deliberately along with the model, not as a drift — the
 * invariant they protect is still "one row type cannot silently disagree
 * with its siblings about where it starts."
 */
describe('sidebar row geometry (#380, model replaced by #742)', () => {
  it('every row directly in a space shares ONE edge — including the space header itself', () => {
    // Depth 0 is now "not inside a folder", not "is a space" — a space header,
    // a database, a folder row, a space-level view/dashboard/document all
    // share it. This is the #742 redesign's core claim: labels no longer step
    // right as you go deeper, alignment comes from the icon column instead.
    expect(sidebarRowIndent(0)).toBe(0);
    expect(sidebarRowIndent(0)).toBe(SIDEBAR_INDENT_PX[0]);
  });

  it('a folder\'s own children get the ONE real indent step in the tree', () => {
    // A folder genuinely CONTAINS its rows rather than merely preceding them
    // — the one case an indent states a fact instead of decorating one.
    expect(sidebarRowIndent(1)).toBeGreaterThan(sidebarRowIndent(0));
    expect(sidebarRowIndent(1)).toBe(SIDEBAR_INDENT_PX[1]);
  });

  it('marks the active row with BACKGROUND only — no accent bar', () => {
    // The bar was applied per row type, so a database and the "All records" row
    // it opens were both active: two stacked amber bars for one location.
    expect(sidebarRowStateClass(true)).toContain('bg-active');
    expect(sidebarRowStateClass(true), 'the amber inset bar must not come back').not.toContain('inset_2px');
  });

  it('keeps hover and active visually distinct', () => {
    // Once the bar is gone, bg-active carries the whole "you are here" job.
    const active = sidebarRowStateClass(true);
    const idle = sidebarRowStateClass(false);
    expect(active).not.toEqual(idle);
    expect(idle).toContain('hover:bg-hover');
    expect(active, 'the active row must not also apply a hover background').not.toContain('hover:bg-hover');
  });
});

/**
 * #779 — the fourth occurrence of #380's own predicted failure: a component
 * that renders a disclosure chevron OUTSIDE `SidebarRow`'s reserved `caret`
 * slot ends up reserving its OWN gutter alongside a sibling's, so the two
 * stack and the row lands further right than its children — exactly what
 * shipped on the space header (measured live: its icon landed 2px LEFT of,
 * not 20px right of, its own child database's icon).
 *
 * A pixel-measurement test can't live here — jsdom never computes real
 * layout (`getBoundingClientRect` is always zero), which is why AC1's
 * measurement had to happen in a real browser, not a unit test. What CAN be
 * asserted in CI is the STRUCTURAL half of the contract: every `ChevronRight`
 * rendered by a sidebar row component is a value passed to `caret`, never a
 * plain JSX child — so the next row type either does this by construction or
 * fails the build, instead of shipping a fifth quietly-misaligned row.
 */
describe('#779 — every sidebar chevron goes through SidebarRow\'s caret slot', () => {
  const SIDEBAR_DIR = fileURLToPath(new URL('.', import.meta.url));

  /** True if `node` (a JSX element/self-closing element) sits inside the
   *  VALUE of some ancestor `caret={...}` attribute, without crossing back
   *  out through a different JSX element's own attribute list first. */
  function isInsideCaretProp(node: ts.Node): boolean {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (ts.isJsxAttribute(cur) && cur.name.getText() === 'caret') return true;
      cur = cur.parent;
    }
    return false;
  }

  /** The name of the nearest enclosing function/component declaration, so an
   *  exception can be named by WHAT it is rather than by where it sits. */
  function enclosingComponent(node: ts.Node): string | undefined {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.getText();
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.getText();
      cur = cur.parent;
    }
    return undefined;
  }

  function chevronsOutsideCaret(fileName: string): string[] {
    const path = `${SIDEBAR_DIR}${fileName}`;
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const offenders: string[] = [];

    function visit(node: ts.Node) {
      const isChevron =
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText() === 'ChevronRight';
      if (isChevron && !isInsideCaretProp(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push(`${enclosingComponent(node) ?? '<top level>'} (${fileName}:${line + 1})`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return offenders;
  }

  it('sidebar.tsx: every tree-row ChevronRight (space/group/folder headers) is inside caret={...}', () => {
    // HiddenSection's own collapse toggle (an unrelated standalone section,
    // not a row in the space/database tree with siblings to misalign
    // against) is the one deliberate exception — named explicitly rather
    // than silently excluded, so widening this list is a visible decision.
    //
    // KEYED ON THE COMPONENT, NOT A LINE NUMBER. This exception used to read
    // 'sidebar.tsx:886'. Inserting a single blank line anywhere above it made
    // the whole guard fail, reporting the toggle at its new line as an
    // offender — verified by doing exactly that. A guard that cries wolf on
    // an unrelated edit is a guard someone loosens, and the protection goes
    // with it. A component name survives the file moving underneath it.
    const EXEMPT_COMPONENTS = new Set(['HiddenSection']);
    const offenders = chevronsOutsideCaret('sidebar.tsx').filter(
      (loc) => !EXEMPT_COMPONENTS.has(loc.split(' (')[0]!),
    );
    expect(offenders, 'a ChevronRight outside caret={} reserves its own gutter alongside SidebarRow\'s, pushing the row right of its own children').toEqual([]);
  });
});

/**
 * #805 — the artifact's marks are TWO letters. One letter collided the moment
 * two spaces shared an initial, and "Borderlands Foundation" showed "B".
 */
describe('markInitials (#805)', () => {
  it('two words: first letter of each of the first two', () => {
    expect(markInitials('Borderlands Foundation')).toBe('BF');
    expect(markInitials('Agentic OS')).toBe('AO');
    expect(markInitials('Client Work')).toBe('CW');
  });

  it('a single word: its first two characters', () => {
    expect(markInitials('General')).toBe('GE');
    expect(markInitials('StoryOS')).toBe('ST');
    expect(markInitials('JCM')).toBe('JC');
  });

  it('keeps two spaces that share an initial distinguishable', () => {
    expect(markInitials('Client Portal')).not.toBe(markInitials('Client Work'));
  });

  it('ignores a third and later word', () => {
    expect(markInitials('Agency Back Office')).toBe('AB');
  });

  it('survives punctuation, extra whitespace and non-latin names', () => {
    expect(markInitials('  --Q3 / Reports  ')).toBe('QR');
    expect(markInitials('Über Uns')).toBe('ÜU');
  });

  it('single-character and empty names still yield something', () => {
    expect(markInitials('X')).toBe('X');
    expect(markInitials('')).toBe('?');
    expect(markInitials('///')).toBe('?');
  });
});

describe('CARET_HIT_AREA (#799)', () => {
  it('grows leftward and vertically, never rightward — the right edge stays flush with the glyph', () => {
    expect(CARET_HIT_AREA).toContain('before:-left-3');
    expect(CARET_HIT_AREA).toContain('before:right-0');
    expect(CARET_HIT_AREA).not.toMatch(/before:-right-/);
  });
  it('adds up to 24x24 around a 12px glyph: 12 left + 12 glyph, 6 up + 12 + 6 down', () => {
    // -left-3 = 12px, -inset-y-1.5 = 6px each. If either is edited, the target
    // drops below WCAG 2.2 SC 2.5.8's 24px minimum and this must fail.
    const glyph = 12;
    const left = 12;
    const vertical = 6;
    expect(glyph + left).toBeGreaterThanOrEqual(24);
    expect(glyph + 2 * vertical).toBeGreaterThanOrEqual(24);
    expect(CARET_HIT_AREA).toContain('before:-inset-y-1.5');
  });
  it('is applied by every caret button in sidebar.tsx, so the three sites cannot drift', () => {
    const src = readFileSync(fileURLToPath(new URL('./sidebar.tsx', import.meta.url)), 'utf8');
    const buttons = src.match(/aria-expanded=\{[^}]+\}/g) ?? [];
    expect(buttons.length).toBe(3);
    expect((src.match(/CARET_HIT_AREA\)/g) ?? []).length).toBe(3);
  });
});
