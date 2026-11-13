import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Settings parity guard (ticket #1190, the last of the six #974 tickets).
 *
 * WHY: ticket #974 redesigned every Settings page against a 245-row table of "every control, today -> new home". The table was
 * generated once, from one commit, and a table like that is a prefix of reality: it passes for exactly the rows it omits (it had no
 * Runners and no Packs rows, because those pages did not exist yet). Nothing at compile time notices a control that quietly
 * disappears in a later refactor, which is how the same defect has shipped before (CLAUDE.md, "When a check is wrong about what it
 * checks"). This test re-derives the control inventory FROM THE SOURCE TREE on every run, so the set is defined by the repo and not
 * by a search term or by a list someone remembered to update.
 *
 * HOW: it parses every Settings source file (the pages, components/settings, components/connections, and every component a Settings
 * page imports from components/, found by following the imports) with the TypeScript compiler and counts the interactive elements
 * by kind. Two checks sit on top of that:
 *   1. PINS: the per-file count of each kind. Dropping a control, or adding one without saying so, changes a count and fails. A file
 *      with controls that is not pinned fails too (a new Settings component cannot slip in unseen).
 *   2. NAMED ROWS: for each of the 245 rows of the #974 table, the file that is its home today and the text that identifies the
 *      control there. A row can only leave this list by being named in `REMOVED_ON_PURPOSE` with the decision that removed it.
 *
 *   3. HANDLERS: every Button, menu item, switch and select must carry its own onClick/onSelect/onCheckedChange/onChange (or submit,
 *      or be wrapped by the trigger, link or form that acts for it). A control that is drawn but dead (a Revoke with its onClick gone)
 *      passes a presence check, so this is checked separately; exceptions go in NO_HANDLER_BY_DESIGN with a reason.
 *
 * WHAT EACH CHECK DOES AND DOES NOT PROTECT (be honest about the weak parts):
 *   - PINS count elements by kind per file. They catch a control dropped or added, but not one control swapped for another of the
 *     same kind in the same file.
 *   - NAMED ROWS: a needle that is the label of interactive elements is checked as "at least N ELEMENTS carry this label in this
 *     file" (the 4th field), so losing one of two Cancel buttons fails its row. About 80 rows have a needle that is code (an
 *     identifier such as confirmRevokeInvite, or a conditional label expression); those are a plain substring check, which proves
 *     the text is in the file, not that it is on a control. Those rows are really held by the PINS and the HANDLERS check.
 *   - FIXED rows ("the 16 the table marked Fixed") are held only where an assertion names the fix (FIXED_ROWS_DELIVERED, and the
 *     behavioural test in remove-photo.unit.test.ts). The rest of Settings' behaviour is NOT executed here: this repo has no DOM test
 *     setup, so these are source checks plus one pure function driven with a failing request.
 *
 * To change a pin on purpose: run `PRINT_SETTINGS_INVENTORY=/tmp/inv.json pnpm --filter @storyos/web exec vitest run settings-parity`
 * (it writes the current inventory to that file), edit PINS, and say in the PR which control was added or removed and why. For a
 * changed row needle: `PRINT_ROW_MINS=/tmp/mins.json` writes the element counts to put in the 4th field of PARITY_ROWS.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_DIR = join(SRC, 'app/w/[ws]/settings');

type Kind = 'button' | 'link' | 'field' | 'choice' | 'nativeSelect' | 'switch' | 'disclosure' | 'copy' | 'menuitem' | 'confirm';
type Counts = Partial<Record<Kind, number>>;

const KIND_OF_TAG: Record<string, Kind> = {
  Button: 'button', button: 'button',
  Link: 'link', a: 'link',
  Input: 'field', input: 'field', Textarea: 'field', textarea: 'field',
  MenuSelect: 'choice', Segmented: 'choice',
  select: 'nativeSelect', SelectField: 'nativeSelect',
  Switch: 'switch',
  summary: 'disclosure', AdvancedSection: 'disclosure',
  CopyBox: 'copy',
  DropdownMenuItem: 'menuitem',
};

/** Components a Settings page imports from `components/` that are NOT Settings controls, each with its reason. */
const NOT_SETTINGS_CONTROLS: Record<string, string> = {
  'components/pack-install-dialog.tsx': 'the Packs marketplace install dialog: it opens from Settings > Packs for an update, but it is the marketplace\'s own dialog (ticket #1186 reuses it)',
  'components/integration-setup-guide.tsx': 'a read-only "how setup works" checklist, no controls',
  'components/connect-ai-logos.tsx': 'logos only',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith('.tsx') && !name.includes('.unit.test')) out.push(full);
  }
  return out;
}

/**
 * The components a file imports: `@/components/...` (skipping the shared UI kit, `components/ui/`) and `./sibling` imports, resolved
 * to a .tsx path under src. A `.ts` import (a hook, a lib) has no markup, so it is not a source of controls.
 */
function importedComponents(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const m of text.matchAll(/from '@\/(components\/(?!ui\/)[^']+)'/g)) {
    const p = join(SRC, m[1] + '.tsx');
    if (existsSync(p)) found.push(p);
  }
  for (const m of text.matchAll(/from '\.\/([^'/]+)'/g)) {
    const p = join(dirname(file), m[1] + '.tsx');
    if (existsSync(p)) found.push(p);
  }
  return found;
}

/**
 * Settings components that no Settings page imports but that ARE a home of rows in the #974 table: the avatar menu (Account/Profile,
 * Preferences, Keyboard shortcuts, Sign out) is rendered by the sidebar, so only this list can reach it.
 */
const ALSO_SETTINGS: Record<string, string> = {
  'components/account-menu.tsx': 'the rail avatar menu: Profile, Preferences, photo, Keyboard shortcuts, Sign out (table rows "Rail avatar" and "Rail bottom gear" #6, #7)',
};

/** The Settings source set: derived from the tree (and the imports of what is in it), never listed by hand. */
function settingsFiles(): string[] {
  const set = new Set<string>();
  // An excluded component is never added, so nothing it imports is pulled in through it either.
  const add = (f: string) => { if (!NOT_SETTINGS_CONTROLS[relative(SRC, f)]) set.add(f); };
  for (const f of sourceFiles(SETTINGS_DIR)) add(f);
  for (const dir of ['components/settings', 'components/connections']) for (const f of sourceFiles(join(SRC, dir))) add(f);
  for (const f of Object.keys(ALSO_SETTINGS)) add(join(SRC, f));
  // Two hops out: a Settings page imports a component, and that component imports its own pieces (runner-row -> sharing-section).
  for (let hop = 0; hop < 2; hop += 1) for (const f of [...set]) for (const imp of importedComponents(f)) add(imp);
  return [...set].sort();
}

const rel = (f: string) => relative(SRC, f);

export function inventoryOf(file: string): Counts {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const counts: Counts = {};
  const add = (k: Kind) => { counts[k] = (counts[k] ?? 0) + 1; };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(sf);
      const kind = KIND_OF_TAG[tag];
      if (kind) {
        // A Link that only wraps a Button is one control (the Button), not two.
        const wrapsButton =
          ts.isJsxElement(node) &&
          (kind === 'link') &&
          node.children.some((c) => (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && ['Button', 'button'].includes((ts.isJsxElement(c) ? c.openingElement : c).tagName.getText(sf)));
        if (!wrapsButton) add(kind);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'confirm') add('confirm');
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

/**
 * `title=` attributes on plain HTML elements: the browser tooltip, which a touch screen or a keyboard never shows. Ticket #974's rule 5 is
 * that an explanation is written on the page, so a hover-only one is a defect. (A `title` prop on a component such as SettingsRow is a
 * heading, not a tooltip, so only lower-case tags count.)
 */
export function hoverOnlyTitles(file: string): number {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (/^[a-z]/.test(tag) && node.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'title')) n += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}


const ACTION_TAGS: Record<string, string[]> = {
  Button: ['onClick'], button: ['onClick'], DropdownMenuItem: ['onSelect'], Switch: ['onCheckedChange'],
  MenuSelect: ['onChange', 'onValueChange'], Segmented: ['onChange', 'onValueChange'], SelectField: ['onChange'], select: ['onChange'],
};
/** An element whose handler is supplied by an ancestor (a trigger or a link wraps it), by a form (submit), or by a spread. */
const HANDLER_FROM_ANCESTOR = new Set(['DialogClose', 'DialogTrigger', 'DropdownMenuTrigger', 'PopoverTrigger', 'Link', 'a', 'form']);

/**
 * Controls that are drawn but carry no handler of their own: `<Button>`, `<button>`, a menu item, a switch or a select with no `onClick`/
 * `onSelect`/`onCheckedChange`/`onChange`. Such an element is a dead control: it looks present, so a presence check passes (that is how
 * "Revoke with its onClick removed" slipped past a count-and-label guard). An element is fine when it submits (`type="submit"`), is
 * wrapped by a trigger/link/form that acts for it, spreads props, or is named in NO_HANDLER_BY_DESIGN with a reason.
 */
export function handlerless(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const needs = ACTION_TAGS[tag];
      if (needs) {
        const attrs = node.attributes.properties;
        const has = (n: string) => attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === n);
        const submits = attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'type' && a.initializer?.getText(sf).includes('submit'));
        const spreads = attrs.some((a) => ts.isJsxSpreadAttribute(a));
        let wrapped = false;
        for (let p: ts.Node | undefined = node.parent?.parent; p && !ts.isSourceFile(p); p = p.parent) {
          if (ts.isJsxElement(p) && HANDLER_FROM_ANCESTOR.has(p.openingElement.tagName.getText(sf))) { wrapped = true; break; }
          if (ts.isJsxElement(p) && p.openingElement.tagName.getText(sf) === tag) break;
        }
        const own = needs.some(has) || has('asChild') || submits || spreads || has('href');
        if (!own && !wrapped) {
          const el = ts.isJsxOpeningElement(node) ? node.parent : node;
          const label = el.getText(sf).replace(/\s+/g, ' ').replace(/<[^>]*>/g, ' ').trim().slice(0, 40);
          out.push(`${tag} "${label}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Drawn controls with no handler on purpose, each with its reason. Empty today: every action control in Settings acts. */
const NO_HANDLER_BY_DESIGN: Record<string, string> = {};

/** The only `title=` tooltips left on Settings, each one a NAME for an icon-only control that also has an aria-label, never an explanation. */
const ALLOWED_TITLE_TOOLTIPS: Record<string, string> = {
  'components/free-guest-tip.tsx': 'the icon-only Dismiss button',
  'components/account-menu.tsx': 'the rail avatar button shows the person\'s name',
};

function currentInventory(): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const f of settingsFiles()) {
    const c = inventoryOf(f);
    if (Object.keys(c).length > 0) out[rel(f)] = c;
  }
  return out;
}


/**
 * The visible labels of each interactive element in a file: its text (including string literals inside `{...}`), and its `aria-label`,
 * `label`, `placeholder`, `id` and `title` attributes. One entry per element, so "how many Cancel buttons are in this file" is a count
 * of ELEMENTS, not of occurrences of the word.
 */
export function elementLabels(file: string): string[][] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[][] = [];
  const strings = (n: ts.Node, acc: string[]) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) acc.push(n.text);
    else if (ts.isJsxText(n)) { const t = n.getText(sf).replace(/\s+/g, ' ').trim(); if (t) acc.push(t); }
    else ts.forEachChild(n, (c) => strings(c, acc));
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(sf);
      if (KIND_OF_TAG[tag]) {
        const labels: string[] = [];
        for (const a of opening.attributes.properties) {
          if (ts.isJsxAttribute(a) && ['aria-label', 'label', 'placeholder', 'id', 'title'].includes(a.name.getText(sf)) && a.initializer) strings(a.initializer, labels);
        }
        if (ts.isJsxElement(node)) for (const c of node.children) if (!(ts.isJsxElement(c) && KIND_OF_TAG[c.openingElement.tagName.getText(sf)])) strings(c, labels);
        out.push(labels);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** How many interactive elements in `file` carry a label containing `needle`. */
export const elementsLabelled = (file: string, needle: string): number => elementLabels(file).filter((ls) => ls.some((l) => l.includes(needle))).length;

/** Pinned per-file counts at ticket #1190 (main 86fb95d1). See the header for how to change one on purpose. */
const PINS: Record<string, Counts> = {
  // PINS-BEGIN
  "app/w/[ws]/settings/account/page.tsx": { button: 8, field: 5, disclosure: 1, confirm: 2 },
  "app/w/[ws]/settings/agent-rules/page.tsx": { switch: 1 },
  "app/w/[ws]/settings/api/page.tsx": { button: 6, link: 1, field: 3, disclosure: 1, confirm: 2 },
  "app/w/[ws]/settings/audit-log/page.tsx": { button: 1, field: 3, choice: 2, disclosure: 1 },
  "app/w/[ws]/settings/billing/page.tsx": { button: 3, link: 2 },
  "app/w/[ws]/settings/connect-ai/page.tsx": { button: 7, link: 3, disclosure: 2, copy: 5 },
  "app/w/[ws]/settings/export/page.tsx": { link: 1 },
  "app/w/[ws]/settings/general/page.tsx": { button: 2, field: 5, disclosure: 1 },
  "app/w/[ws]/settings/integrations/[provider]/page.tsx": { link: 1 },
  "app/w/[ws]/settings/integrations/delegate-agent/page.tsx": { button: 1, link: 1 },
  "app/w/[ws]/settings/integrations/github/page.tsx": { button: 5, link: 1, field: 3, nativeSelect: 3, switch: 4 },
  "app/w/[ws]/settings/integrations/google-calendar/page.tsx": { button: 8, link: 1, field: 2, nativeSelect: 8, confirm: 1 },
  "app/w/[ws]/settings/integrations/linear/page.tsx": { button: 4, field: 2, nativeSelect: 1, switch: 2, confirm: 1 },
  "app/w/[ws]/settings/integrations/page.tsx": { link: 4 }, // ticket #1285: the Add-row Connect is the link itself (was a Button inside a Link)
  "app/w/[ws]/settings/integrations/shopify/page.tsx": { button: 6, field: 1, nativeSelect: 1 },
  "app/w/[ws]/settings/integrations/slack/page.tsx": { button: 1, link: 1, field: 3, choice: 1 },
  "app/w/[ws]/settings/integrations/youtube/page.tsx": { button: 4, field: 1, nativeSelect: 1 },
  "app/w/[ws]/settings/members/page.tsx": { button: 12, field: 4, choice: 2, disclosure: 1, menuitem: 3, confirm: 3 },
  "app/w/[ws]/settings/notifications/page.tsx": { link: 3, switch: 1 },
  "app/w/[ws]/settings/packs/page.tsx": { button: 2, link: 1, disclosure: 1, confirm: 1 },
  "app/w/[ws]/settings/page.tsx": { link: 1 },
  "app/w/[ws]/settings/preferences/page.tsx": { choice: 4 },
  "app/w/[ws]/settings/referrals/page.tsx": { button: 1, field: 1 },
  "app/w/[ws]/settings/runners/page.tsx": { button: 2, confirm: 1 },
  "app/w/[ws]/settings/webhooks/page.tsx": { button: 8, link: 1, field: 2, nativeSelect: 1, disclosure: 1, confirm: 2 },
  "components/account-menu.tsx": { button: 2, field: 1, menuitem: 6 },
  "components/connections/base-url-dialog.tsx": { button: 3, field: 1 },
  "components/connections/connect-dialogs.tsx": { button: 6, link: 1, field: 18, choice: 2, disclosure: 3 },
  "components/entity/trash-list.tsx": { button: 2 },
  "components/settings/my-work-email-box.tsx": { choice: 3, link: 1, switch: 1 },
  "components/free-guest-tip.tsx": { button: 1, link: 1 },
  "components/governance/agent-actions.tsx": { button: 2 },
  "components/governance/default-agent-model.tsx": { choice: 1 },
  "components/quill/not-found-view.tsx": { link: 1 },
  "components/runners/pairing-blocks.tsx": { button: 1, link: 1 },
  "components/runners/pairing-card.tsx": { button: 3, choice: 1 },
  "components/runners/runner-row.tsx": { button: 1, disclosure: 1 },
  "components/runners/sharing-section.tsx": { button: 1, choice: 3, switch: 2 },
  "components/settings/ai-connections-list.tsx": { button: 2, confirm: 1 },
  "components/settings/copy-box.tsx": { button: 1 },
  "components/settings/github-untracked.tsx": { button: 2 },
  "components/settings/provider-card.tsx": { button: 7, link: 1, disclosure: 1, confirm: 1 },
  "components/settings/settings-chrome.tsx": { disclosure: 1 },
  "components/settings/setup-disclosure.tsx": { disclosure: 1 },
  "components/settings/settings-sidebar-menu.tsx": { link: 2 },
  "components/social-ingest-setup.tsx": { button: 1 },
  // PINS-END
};

/**
 * The 245 rows of the #974 parity table (read from main 21282ebb), each with where it
 * lives TODAY and the text that identifies the control in that file. Key = "table page#row number". A "merged" row names its KEPT copy
 * (the file listed is the copy that stays); a "moved" row names its new home. Checked against main 86fb95d1 by ticket #1190.
 */
const PARITY_ROWS: ReadonlyArray<readonly [string, string, string, number]> = [
  ["Rail bottom gear#1", "lib/settings-nav.ts", "label: 'General'", 0],
  ["Rail bottom gear#2", "lib/settings-nav.ts", "label: 'Integrations'", 0],
  ["Rail bottom gear#3", "components/settings/provider-card.tsx", "has('test')", 0],
  ["Rail bottom gear#4", "lib/settings-nav.ts", "label: 'Webhooks'", 0],
  ["Rail bottom gear#5", "lib/settings-nav.ts", "label: 'API tokens'", 0],
  ["Rail bottom gear#6", "components/account-menu.tsx", "Keyboard shortcuts", 1],
  ["Rail bottom gear#7", "components/account-menu.tsx", "Sign out", 1],
  ["Rail avatar#1", "components/account-menu.tsx", "Profile", 1],
  ["Rail avatar#2", "components/account-menu.tsx", "Preferences", 1],
  ["Rail avatar#3", "components/account-menu.tsx", "imageUrl ? 'Change photo' : 'Set photo'", 0],
  ["Rail avatar#4", "components/account-menu.tsx", "Remove photo", 1],
  ["Rail avatar#5", "components/account-menu.tsx", "Sign out", 1],
  ["Account#1", "app/w/[ws]/settings/account/page.tsx", "imageUrl ? 'Change' : 'Upload'", 0],
  ["Account#2", "app/w/[ws]/settings/account/page.tsx", "type=\"file\"", 0],
  ["Account#3", "app/w/[ws]/settings/account/page.tsx", "confirmRemovePhoto", 0],
  ["Account#4", "app/w/[ws]/settings/account/page.tsx", "display-name", 1],
  ["Account#5", "app/w/[ws]/settings/account/page.tsx", "save.isPending ? 'Saving\u2026' : 'Save'", 0],
  ["Account#6", "app/w/[ws]/settings/account/page.tsx", "cur-pw", 1],
  ["Account#7", "app/w/[ws]/settings/account/page.tsx", "new-pw", 1],
  ["Account#8", "app/w/[ws]/settings/account/page.tsx", "Change password", 1],
  ["Account#9", "app/w/[ws]/settings/account/page.tsx", "confirmRevokeSession", 0],
  ["Account#10", "app/w/[ws]/settings/account/page.tsx", "Delete my account\u2026", 1],
  ["Account#11", "app/w/[ws]/settings/account/page.tsx", "delete-account-confirm", 1],
  ["Account#12", "app/w/[ws]/settings/account/page.tsx", "Cancel", 1],
  ["Account#13", "app/w/[ws]/settings/account/page.tsx", "erase.isPending ? 'Deleting\u2026' : 'Delete my account permanently'", 0],
  ["Preferences#1", "app/w/[ws]/settings/preferences/page.tsx", "Theme", 1],
  ["Preferences#2", "app/w/[ws]/settings/preferences/page.tsx", "Date format", 1],
  ["Preferences#3", "app/w/[ws]/settings/preferences/page.tsx", "Time format", 1],
  ["Preferences#4", "app/w/[ws]/settings/preferences/page.tsx", "Week starts on", 1],
  ["Notifications#1", "app/w/[ws]/settings/notifications/page.tsx", "label: 'Assigned to me'", 0],
  ["Notifications#2", "app/w/[ws]/settings/notifications/page.tsx", "label: 'Mentions'", 0],
  ["Notifications#3", "app/w/[ws]/settings/notifications/page.tsx", "label: 'Comments'", 0],
  ["Notifications#4", "app/w/[ws]/settings/notifications/page.tsx", "label: 'Status changes'", 0],
  ["Notifications#5", "app/w/[ws]/settings/notifications/page.tsx", "label: 'Record changes'", 0],
  ["Referrals#1", "app/w/[ws]/settings/referrals/page.tsx", "Your referral link", 1],
  ["Referrals#2", "app/w/[ws]/settings/referrals/page.tsx", "Copy", 1],
  ["General#1", "app/w/[ws]/settings/general/page.tsx", "What is this workspace for? One line. Agents read it to understand what lives h", 1],
  ["General#2", "app/w/[ws]/settings/general/page.tsx", "updateWorkspace.isPending ? 'Saving\u2026' : 'Save'", 0],
  ["General#3", "app/w/[ws]/settings/agent-rules/page.tsx", "Let AI share skills with the whole workspace", 1],
  ["General#4", "app/w/[ws]/settings/general/page.tsx", "https://your-domain.com/logo.png", 2],
  ["General#5", "app/w/[ws]/settings/general/page.tsx", "Pick an accent colour", 2],
  ["General#6", "app/w/[ws]/settings/general/page.tsx", "#3366ff", 2],
  ["General#7", "app/w/[ws]/settings/general/page.tsx", "Save branding", 2],
  ["Members#1", "app/w/[ws]/settings/members/page.tsx", "Invite", 1],
  ["Members#2", "components/free-guest-tip.tsx", "Dismiss", 1],
  ["Members#3", "app/w/[ws]/settings/members/page.tsx", "invite-email", 1],
  ["Members#4", "app/w/[ws]/settings/members/page.tsx", "Role", 1],
  ["Members#5", "app/w/[ws]/settings/members/page.tsx", "Access level", 1],
  ["Members#6", "app/w/[ws]/settings/members/page.tsx", "type=\"checkbox\"", 0],
  ["Members#7", "app/w/[ws]/settings/members/page.tsx", "initialOpen ? 'Skip for now' : 'Cancel'", 0],
  ["Members#8", "app/w/[ws]/settings/members/page.tsx", "Send invite", 1],
  ["Members#9", "app/w/[ws]/settings/members/page.tsx", "value={acceptUrl}", 0],
  ["Members#10", "app/w/[ws]/settings/members/page.tsx", "Copy", 2],
  ["Members#11", "app/w/[ws]/settings/members/page.tsx", "Done", 1],
  ["Members#12", "app/w/[ws]/settings/members/page.tsx", "confirmRoleChange", 0],
  ["Members#13", "app/w/[ws]/settings/members/page.tsx", "MEMBERS_COPY.choosePerson", 0],
  ["Members#14", "app/w/[ws]/settings/members/page.tsx", "removeMember.mutate", 0],
  ["Members#15", "app/w/[ws]/settings/members/page.tsx", "EraseMemberDialog", 0],
  ["Members#16", "app/w/[ws]/settings/members/page.tsx", "Type ${target} to confirm", 0],
  ["Members#17", "app/w/[ws]/settings/members/page.tsx", "Cancel", 2],
  ["Members#18", "app/w/[ws]/settings/members/page.tsx", "Erase from this workspace", 1],
  ["Members#19", "app/w/[ws]/settings/members/page.tsx", "Copy link", 1],
  ["Members#20", "app/w/[ws]/settings/members/page.tsx", "model.resendLabel", 0],
  ["Members#21", "app/w/[ws]/settings/members/page.tsx", "confirmRevokeInvite", 0],
  ["Connect your AI#1", "app/w/[ws]/settings/connect-ai/page.tsx", "CONNECT_CLIENTS[id].label", 0],
  ["Connect your AI#2", "app/w/[ws]/settings/connect-ai/page.tsx", "connector name", 2],
  ["Connect your AI#3", "app/w/[ws]/settings/connect-ai/page.tsx", "server address", 2],
  ["Connect your AI#4", "app/w/[ws]/settings/connect-ai/page.tsx", "I\u2019ve done it \u2014 check the connection", 1],
  ["Connect your AI#5", "app/w/[ws]/settings/connect-ai/page.tsx", "Connect another AI \u2192", 1],
  ["Connect your AI#6", "components/settings/ai-connections-list.tsx", "busy ? 'Disconnecting\u2026' : 'Disconnect'", 0],
  ["Connect your AI#7", "app/w/[ws]/settings/connect-ai/page.tsx", "Advanced \u2014 tokens and self-managed StoryOS", 1],
  ["Connect your AI#8", "app/w/[ws]/settings/connect-ai/page.tsx", "Manage API tokens \u2192", 1],
  ["Connect your AI#9", "app/w/[ws]/settings/connect-ai/page.tsx", "Troubleshooting", 1],
  ["Connect your AI#10", "app/w/[ws]/settings/connect-ai/page.tsx", "Claude client ID", 1],
  ["Connect your AI#11", "app/w/[ws]/settings/connect-ai/page.tsx", "Check hosted service", 1],
  ["Connect your AI#12", "app/w/[ws]/settings/connect-ai/page.tsx", "{selected.label} connector reference", 0],
  ["Billing#1", "app/w/[ws]/settings/billing/page.tsx", "Start 30-day Pro trial", 1],
  ["Billing#2", "app/w/[ws]/settings/billing/page.tsx", "UPGRADE_LABEL[target]", 0],
  ["Billing#3", "lib/billing-view.ts", "business: 'Upgrade to Business'", 0],
  ["Billing#4", "app/w/[ws]/settings/billing/page.tsx", "Manage billing", 1],
  ["Billing#5", "app/w/[ws]/settings/billing/page.tsx", "BILLING_COPY.seatsLink", 0],
  ["Integrations (hub)#1", "app/w/[ws]/settings/integrations/page.tsx", "Connect your AI", 1],
  ["Integrations (hub)#2", "app/w/[ws]/settings/connect-ai/page.tsx", "server address", 2],
  ["Integrations (hub)#3", "app/w/[ws]/settings/integrations/page.tsx", "providerPageHref(ws, s.def.id)", 0],
  ["Integrations (hub)#4", "components/settings/provider-card.tsx", "Disconnect", 1],
  ["Integrations (hub)#5", "app/w/[ws]/settings/integrations/page.tsx", "providerPageHref(ws, s.def.id)", 0],
  ["API tokens#1", "app/w/[ws]/settings/api/page.tsx", "New token", 1],
  ["API tokens#2", "app/w/[ws]/settings/api/page.tsx", "How to use a token", 1], // ticket #1285: the disclosure is the shared AdvancedSection, retitled as the prototype's
  ["API tokens#3", "app/w/[ws]/settings/api/page.tsx", "the API", 1],
  ["API tokens#4", "app/w/[ws]/settings/api/page.tsx", "type=\"checkbox\"", 0],
  ["API tokens#5", "app/w/[ws]/settings/api/page.tsx", "confirmRevokeToken", 0],
  ["API tokens#6", "app/w/[ws]/settings/api/page.tsx", "e.g. slack-digest", 1],
  ["API tokens#7", "app/w/[ws]/settings/api/page.tsx", "Cancel", 1],
  ["API tokens#8", "app/w/[ws]/settings/api/page.tsx", "Create", 1],
  ["API tokens#9", "app/w/[ws]/settings/api/page.tsx", "value={created}", 0],
  ["API tokens#10", "app/w/[ws]/settings/api/page.tsx", "Copy", 1],
  ["API tokens#11", "app/w/[ws]/settings/api/page.tsx", "Done", 1],
  ["Export#1", "app/w/[ws]/settings/export/page.tsx", "Export", 1],
  ["Trash#1", "components/entity/trash-list.tsx", "Restore", 2],
  ["Trash#2", "components/entity/trash-list.tsx", "Restore", 2],
  ["Audit log#1", "app/w/[ws]/settings/audit-log/page.tsx", "Actor", 2],
  ["Audit log#2", "app/w/[ws]/settings/audit-log/page.tsx", "Type", 2],
  ["Audit log#3", "app/w/[ws]/settings/audit-log/page.tsx", "One record, space, database or view\u2026", 2],
  ["Audit log#4", "app/w/[ws]/settings/audit-log/page.tsx", "2026-10-27, jul 15, yesterday\u2026", 2],
  ["Audit log#5", "app/w/[ws]/settings/audit-log/page.tsx", "2026-10-27, jul 15, today\u2026", 2],
  ["Audit log#6", "app/w/[ws]/settings/audit-log/page.tsx", "log.isFetchingNextPage ? 'Loading\u2026' : 'Load more'", 0],
  ["Governance#1", "components/governance/agent-actions.tsx", "onClick={() => setOpen(r)}", 0],
  ["Governance#2", "components/governance/agent-actions.tsx", "log.isFetchingNextPage ? 'Loading\u2026' : 'Show older actions'", 0],
  ["Connections#1", "components/settings/provider-card.tsx", "Advanced", 1],
  ["Connections#2", "components/settings/provider-card.tsx", "Resume", 1],
  ["Connections#3", "components/settings/provider-card.tsx", "has('test')", 0],
  ["Connections#4", "components/connections/base-url-dialog.tsx", "needs ? 'Set base URL' : 'Base URL'", 0],
  ["Connections#5", "components/connections/base-url-dialog.tsx", "https://api.example.com/v1", 1],
  ["Connections#6", "components/connections/base-url-dialog.tsx", "Cancel", 1],
  ["Connections#7", "components/connections/base-url-dialog.tsx", "save.isPending ? 'Saving\u2026' : 'Save'", 0],
  ["Connections#8", "app/w/[ws]/settings/integrations/page.tsx", "providerPageHref(ws, s.def.id)", 0],
  ["Connections#9", "components/settings/provider-card.tsx", "Reconnect", 1],
  ["Connections#10", "components/settings/provider-card.tsx", "confirmDisconnectProvider", 0],
  ["Connections#11", "components/settings/provider-card.tsx", "o.info?.oauth?.configured ? o.label : 'Not configured'", 0],
  ["Connections#12", "components/connections/connect-dialogs.tsx", "trigger.label", 0],
  ["Connections#13", "components/connections/connect-dialogs.tsx", "conn-name", 2],
  ["Connections#14", "components/connections/connect-dialogs.tsx", "conn-key", 1],
  ["Connections#15", "components/connections/connect-dialogs.tsx", "automations@yourdomain.com", 2],
  ["Connections#16", "components/connections/connect-dialogs.tsx", "Why do I need a verified domain?", 1],
  ["Connections#17", "components/connections/connect-dialogs.tsx", "Advanced / IT settings", 2],
  ["Connections#18", "components/connections/connect-dialogs.tsx", "whsec_\u2026", 1],
  ["Connections#19", "components/connections/connect-dialogs.tsx", "my-store.myshopify.com", 1],
  ["Connections#20", "components/connections/connect-dialogs.tsx", "shpat_\u2026", 1],
  ["Connections#21", "components/connections/connect-dialogs.tsx", "automations@yourdomain.com", 2],
  ["Connections#22", "components/connections/connect-dialogs.tsx", "Advanced / IT settings", 2],
  ["Connections#23", "components/connections/connect-dialogs.tsx", "smtp-host", 1],
  ["Connections#24", "components/connections/connect-dialogs.tsx", "smtp-port", 1],
  ["Connections#25", "components/connections/connect-dialogs.tsx", "smtp-user", 1],
  ["Connections#26", "components/connections/connect-dialogs.tsx", "smtp-pass", 1],
  ["Connections#27", "components/connections/connect-dialogs.tsx", "Cancel", 2],
  ["Connections#28", "components/connections/connect-dialogs.tsx", "create.isPending ? 'Connecting\u2026' : 'Connect'", 0],
  ["Connections#29", "components/connections/connect-dialogs.tsx", "trigger.label", 0],
  ["Connections#30", "components/connections/connect-dialogs.tsx", "http-conn-name", 1],
  ["Connections#31", "components/connections/connect-dialogs.tsx", "https://api.example.com/v1", 1],
  ["Connections#32", "components/connections/connect-dialogs.tsx", "Auth style", 1],
  ["Connections#33", "components/connections/connect-dialogs.tsx", "http-conn-token", 1],
  ["Connections#34", "components/connections/connect-dialogs.tsx", "http-conn-user", 1],
  ["Connections#35", "components/connections/connect-dialogs.tsx", "http-conn-pass", 1],
  ["Connections#36", "components/connections/connect-dialogs.tsx", "http-conn-hname", 1],
  ["Connections#37", "components/connections/connect-dialogs.tsx", "http-conn-hvalue", 1],
  ["Connections#38", "components/connections/connect-dialogs.tsx", "Cancel", 2],
  ["Connections#39", "components/connections/connect-dialogs.tsx", "create.isPending ? 'Connecting\u2026' : 'Connect'", 0],
  ["Webhooks#1", "app/w/[ws]/settings/webhooks/page.tsx", "Add webhook", 1],
  ["Webhooks#2", "app/w/[ws]/settings/webhooks/page.tsx", "How webhooks work", 1], // ticket #1285: the disclosure is the shared AdvancedSection, last on the page; the signing text moved inside it
  ["Webhooks#3", "app/w/[ws]/settings/webhooks/page.tsx", "Full signing docs", 1],
  ["Webhooks#4", "app/w/[ws]/settings/webhooks/page.tsx", "expanded === hook.id ? 'Hide' : 'Deliveries'", 0],
  ["Webhooks#5", "app/w/[ws]/settings/webhooks/page.tsx", "confirmToggleWebhook", 0],
  ["Webhooks#6", "app/w/[ws]/settings/webhooks/page.tsx", "Delete", 1],
  ["Webhooks#7", "app/w/[ws]/settings/webhooks/page.tsx", "https://hooks.example.com/storyos", 1],
  ["Webhooks#8", "app/w/[ws]/settings/webhooks/page.tsx", "All databases", 1],
  ["Webhooks#9", "app/w/[ws]/settings/webhooks/page.tsx", "type=\"checkbox\"", 0],
  ["Webhooks#10", "app/w/[ws]/settings/webhooks/page.tsx", "Cancel", 1],
  ["Webhooks#11", "app/w/[ws]/settings/webhooks/page.tsx", "create.isPending ? 'Creating\u2026' : 'Create webhook'", 0],
  ["Webhooks#12", "app/w/[ws]/settings/webhooks/page.tsx", "Copy", 1],
  ["Webhooks#13", "app/w/[ws]/settings/webhooks/page.tsx", "Done", 1],
  ["GitHub#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["GitHub#2", "components/settings/provider-card.tsx", "Connect GitHub", 1],
  ["GitHub#3", "app/w/[ws]/settings/integrations/github/page.tsx", "type=\"checkbox\"", 0],
  ["GitHub#4", "app/w/[ws]/settings/integrations/github/page.tsx", "saving ? 'Saving\u2026' : 'Save watched repositories'", 0],
  ["GitHub#5", "app/w/[ws]/settings/integrations/github/page.tsx", "Reconnect / change installation", 1],
  ["GitHub#6", "app/w/[ws]/settings/integrations/github/page.tsx", "ghp_\u2026 (repo read scope)", 1],
  ["GitHub#7", "app/w/[ws]/settings/integrations/github/page.tsx", "acme/website\\nacme/api", 0],
  ["GitHub#8", "app/w/[ws]/settings/integrations/github/page.tsx", "Save", 2],
  ["GitHub#9", "app/w/[ws]/settings/integrations/github/page.tsx", "sync.isPending ? 'Syncing\u2026' : 'Sync now'", 0],
  ["GitHub#10", "app/w/[ws]/settings/integrations/github/page.tsx", "See the GitHub space \u2192", 1],
  ["GitHub#11", "app/w/[ws]/settings/integrations/github/page.tsx", "Enable Code & reviews", 1],
  ["GitHub#12", "app/w/[ws]/settings/integrations/github/page.tsx", "Auto-convert draft PRs", 1],
  ["GitHub#13", "app/w/[ws]/settings/integrations/github/page.tsx", "Squash and merge", 1],
  ["GitHub#14", "app/w/[ws]/settings/integrations/github/page.tsx", "Match system", 1],
  ["GitHub#15", "app/w/[ws]/settings/integrations/github/page.tsx", "Monospace (ligatures)", 1],
  ["GitHub#16", "app/w/[ws]/settings/integrations/github/page.tsx", "Notify on comments and mentions", 1],
  ["GitHub#17", "app/w/[ws]/settings/integrations/github/page.tsx", "Notify on review requests", 1],
  ["Google Calendar#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["Google Calendar#2", "components/settings/provider-card.tsx", "o.info?.oauth?.configured ? o.label : 'Not configured'", 0],
  ["Google Calendar#3", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Create Calendar database", 1],
  ["Google Calendar#4", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Google connection", 1],
  ["Google Calendar#5", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Database", 1],
  ["Google Calendar#6", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Calendar", 2],
  ["Google Calendar#7", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Start date", 1],
  ["Google Calendar#8", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "End date (optional)", 1],
  ["Google Calendar#9", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Description (optional)", 1],
  ["Google Calendar#10", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Sync direction", 1],
  ["Google Calendar#11", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "createBinding.isPending ? 'Saving and syncing\u2026' : 'Save mapping & sync'", 0],
  ["Google Calendar#12", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Open mapped database \u2192", 1],
  ["Google Calendar#13", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Sync", 2],
  ["Google Calendar#14", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "confirmRemoveCalendarMapping", 0],
  ["Google Calendar#15", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "calendar-new-field-name", 1],
  ["Google Calendar#16", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Cancel", 2],
  ["Google Calendar#17", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "createFieldInline.isPending ? 'Creating\u2026' : 'Create and select'", 0],
  ["Google Calendar#18", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Space", 1],
  ["Google Calendar#19", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "calendar-database-name", 1],
  ["Google Calendar#20", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "Cancel", 2],
  ["Google Calendar#21", "app/w/[ws]/settings/integrations/google-calendar/page.tsx", "createCalendarDatabase.isPending ? 'Creating\u2026' : 'Create and map'", 0],
  ["Linear#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["Linear#2", "app/w/[ws]/settings/integrations/linear/page.tsx", "dryRun.isPending ? 'Checking\u2026' : 'Preview import \u2192'", 0],
  ["Linear#3", "app/w/[ws]/settings/integrations/linear/page.tsx", "lin_api_\u2026 (Settings \u2192 API in Linear)", 1],
  ["Linear#4", "app/w/[ws]/settings/integrations/linear/page.tsx", "ENG, OPS", 1],
  ["Linear#5", "app/w/[ws]/settings/integrations/linear/page.tsx", "Save", 1],
  ["Linear#6", "app/w/[ws]/settings/integrations/linear/page.tsx", "dryRun.isPending ? 'Checking\u2026' : 'Preview import'", 0],
  ["Linear#7", "app/w/[ws]/settings/integrations/linear/page.tsx", "run.isPending ? 'Importing\u2026' : 'Import'", 0],
  ["Linear#8", "app/w/[ws]/settings/integrations/linear/page.tsx", "Keep the mirror up to date automatically", 1],
  ["Linear#9", "app/w/[ws]/settings/integrations/linear/page.tsx", "How often", 1],
  ["Linear#10", "app/w/[ws]/settings/integrations/linear/page.tsx", "Post StoryOS comments to Linear", 1],
  ["Slack#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["Slack#2", "app/w/[ws]/settings/integrations/slack/page.tsx", "Slack connection method", 1],
  ["Slack#3", "app/w/[ws]/settings/integrations/slack/page.tsx", "Full setup guide with screenshots \u2192", 1],
  ["Slack#4", "app/w/[ws]/settings/integrations/slack/page.tsx", "xoxb-\u2026", 1],
  ["Slack#5", "app/w/[ws]/settings/integrations/slack/page.tsx", "https://hooks.slack.com/services/\u2026", 1],
  ["Slack#6", "app/w/[ws]/settings/integrations/slack/page.tsx", "#general or C0123456789", 1],
  ["Slack#7", "app/w/[ws]/settings/integrations/slack/page.tsx", "save.isPending ? 'Saving\u2026' : 'Save'", 0],
  ["Slack#8", "components/settings/provider-card.tsx", "has('test')", 0],
  ["Shopify#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["Shopify#2", "components/settings/provider-card.tsx", "o.info?.oauth?.configured ? o.label : 'Not configured'", 0],
  ["Shopify#3", "components/settings/provider-card.tsx", "has('test')", 0],
  ["Shopify#4", "app/w/[ws]/settings/integrations/shopify/page.tsx", "Create Product Catalogue", 1],
  ["Shopify#5", "app/w/[ws]/settings/integrations/shopify/page.tsx", "Open Products", 1],
  ["Shopify#6", "app/w/[ws]/settings/integrations/shopify/page.tsx", "Open Variants", 1],
  ["Shopify#7", "app/w/[ws]/settings/integrations/shopify/page.tsx", "Open Collections", 1],
  ["Shopify#8", "app/w/[ws]/settings/integrations/shopify/page.tsx", "Choose space", 1],
  ["Shopify#9", "app/w/[ws]/settings/integrations/shopify/page.tsx", "e.g. Shopify", 1],
  ["Shopify#10", "app/w/[ws]/settings/integrations/shopify/page.tsx", "Cancel", 1],
  ["Shopify#11", "app/w/[ws]/settings/integrations/shopify/page.tsx", "createCatalogue.isPending ? 'Creating\u2026' : 'Create catalogue'", 0],
  ["YouTube#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["YouTube#2", "components/settings/provider-card.tsx", "o.info?.oauth?.configured ? o.label : 'Not configured'", 0],
  ["YouTube#3", "components/settings/provider-card.tsx", "has('test')", 0],
  ["YouTube#4", "app/w/[ws]/settings/integrations/youtube/page.tsx", "Create database", 2],
  ["YouTube#5", "app/w/[ws]/settings/integrations/youtube/page.tsx", "name: 'YouTube Comments'", 0],
  ["YouTube#6", "app/w/[ws]/settings/integrations/youtube/page.tsx", "name: 'YouTube Metrics'", 0],
  ["YouTube#7", "app/w/[ws]/settings/integrations/youtube/page.tsx", "Open database", 1],
  ["YouTube#8", "app/w/[ws]/settings/integrations/youtube/page.tsx", "Choose space", 1],
  ["YouTube#9", "app/w/[ws]/settings/integrations/youtube/page.tsx", "youtube-database-name", 1],
  ["YouTube#10", "app/w/[ws]/settings/integrations/youtube/page.tsx", "Cancel", 1],
  ["YouTube#11", "app/w/[ws]/settings/integrations/youtube/page.tsx", "createDatabase.isPending ? 'Creating\u2026' : 'Create database'", 0],
  ["Delegate to agent#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["Delegate to agent#2", "app/w/[ws]/settings/integrations/delegate-agent/page.tsx", "enable.isPending ? 'Enabling\u2026' : 'Enable'", 0],
  ["Delegate to agent#3", "app/w/[ws]/settings/integrations/delegate-agent/page.tsx", "Open Agents \u2192", 1],
  ["Meta / X / LinkedIn#1", "components/settings/provider-card.tsx", "\u2190 Integrations", 1],
  ["Meta / X / LinkedIn#2", "components/connections/connect-dialogs.tsx", "trigger.label", 0],
  ["Meta / X / LinkedIn#3", "components/settings/provider-card.tsx", "has('test')", 0],
  ["Meta / X / LinkedIn#4", "components/social-ingest-setup.tsx", "Go to workspace", 1],
];

/**
 * Rows of the table that were removed ON PURPOSE, each with the decision. Empty: the table's own headline is "removed outright: 0", and
 * ticket #1190 found none removed since. To remove a control, add its key here with the ruling that approved it (Dara or Ievgen,
 * on the ticket), and delete its row from PARITY_ROWS in the same commit.
 */
const REMOVED_ON_PURPOSE: Record<string, string> = {};

/**
 * Controls that exist in Settings today and were NOT in the 245-row table, because the page or the control did not exist when the table
 * was read (Runners and Packs are whole pages). Named so that a refactor cannot drop one unnoticed.
 */
const NEW_SINCE_TABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['Runners: Add a Runner', 'app/w/[ws]/settings/runners/page.tsx', 'Add a Runner'],
  ['Runners: pairing Start again', 'components/runners/pairing-card.tsx', 'Start again'],
  ['Runners: which tool', 'components/runners/pairing-card.tsx', 'Which tool your agents use'],
  ['Runners: Remove', 'components/runners/runner-row.tsx', 'Remove'],
  ['Runners: sharing disclosure', 'components/runners/runner-row.tsx', 'Sharing your subscription'],
  ['Packs: Browse packs', 'app/w/[ws]/settings/packs/page.tsx', 'Browse packs'],
  ['Packs: Uninstall', 'app/w/[ws]/settings/packs/page.tsx', 'Uninstall'],
  ['Packs: Update', 'app/w/[ws]/settings/packs/page.tsx', 'updateLabel'],
  ['General: workspace name', 'app/w/[ws]/settings/general/page.tsx', 'workspace-name'],
  ['Agent rules: default model', 'components/governance/default-agent-model.tsx', 'Default model for agents'],
  ['Members: Data requests (Export and Erase pickers)', 'app/w/[ws]/settings/members/page.tsx', 'dataRequestsTitle'],
  ['Connect your AI: Connect an AI', 'app/w/[ws]/settings/connect-ai/page.tsx', 'Connect an AI'],
  ['Connect your AI: Reconnect panel', 'app/w/[ws]/settings/connect-ai/page.tsx', 'ReconnectPanel'],
  ['Connect your AI: API token link', 'app/w/[ws]/settings/connect-ai/page.tsx', 'API token'],
  ['Connect your AI: AI app row Reconnect', 'components/settings/ai-connections-list.tsx', 'Reconnect'],
  ['Custom API: Start from preset', 'components/connections/connect-dialogs.tsx', 'Start from'],
  ['Connection card: Test/Refresh status', 'components/settings/provider-card.tsx', 'testLabel'],
  ['Notifications: pointer to Integrations > GitHub', 'app/w/[ws]/settings/notifications/page.tsx', 'Integrations'],
  ['Notifications (#1264): sentence links the address to Profile', 'app/w/[ws]/settings/notifications/page.tsx', 'Change your address in Profile'],
  ['Notifications (#1264): admin link to the email setup docs', 'app/w/[ws]/settings/notifications/page.tsx', 'How to set it up'],
  ['Notifications (#1252): Email me my work box', 'app/w/[ws]/settings/notifications/page.tsx', 'MyWorkEmailBox'],
  ['Email me my work (#1252): How often', 'components/settings/my-work-email-box.tsx', 'How often'],
  ['Email me my work (#1252): Day (Weekly only)', 'components/settings/my-work-email-box.tsx', 'Day'],
  ['Email me my work (#1252): Time', 'components/settings/my-work-email-box.tsx', 'Time'],
  ['Email me my work (#1252): Include what I assigned to others', 'components/settings/my-work-email-box.tsx', 'Include what I assigned to others'],
  ['Email me my work (#1252): See an example', 'components/settings/my-work-email-box.tsx', 'See an example'],
  ['Settings home: cards', 'app/w/[ws]/settings/page.tsx', 'settingsPageHref'],
  ['Settings menu: Back link', 'components/settings/settings-sidebar-menu.tsx', 'Back to'],
];

/**
 * Native `<select>` elements in Settings. Dara's ruling on ticket #1191 is "no native selects or time pickers anywhere in Settings"
 * (use the shared MenuSelect). These files still have them, found by ticket #1190: listed so the number can only go down. Converting
 * one means lowering its count here AND in PINS.
 */
const NATIVE_SELECTS_STILL_IN_SETTINGS: Record<string, string> = {
  'app/w/[ws]/settings/webhooks/page.tsx': 'Database (create dialog)',
  'app/w/[ws]/settings/integrations/github/page.tsx': 'merge strategy, code theme, code font',
  'app/w/[ws]/settings/integrations/linear/page.tsx': 'How often',
  'app/w/[ws]/settings/integrations/shopify/page.tsx': 'Space (create dialog)',
  'app/w/[ws]/settings/integrations/youtube/page.tsx': 'Space (create dialog)',
  'app/w/[ws]/settings/integrations/google-calendar/page.tsx': 'connection, database, calendar, start, end, description, direction, space',
};

describe('Settings control inventory (derived from the source tree)', () => {
  const inv = currentInventory();

  it('prints the inventory when asked', () => {
    // PRINT_SETTINGS_INVENTORY=/some/file writes the current inventory there, as the PINS below would hold it.
    if (process.env.PRINT_SETTINGS_INVENTORY) writeFileSync(process.env.PRINT_SETTINGS_INVENTORY, JSON.stringify(inv, null, 1));
    // PRINT_ROW_MINS=/some/file writes, for each table row, how many elements carry its needle today (the 4th field of PARITY_ROWS).
    if (process.env.PRINT_ROW_MINS) {
      writeFileSync(process.env.PRINT_ROW_MINS, JSON.stringify(Object.fromEntries(PARITY_ROWS.map(([key, file, needle]) => [key, elementsLabelled(join(SRC, file), needle)]))));
    }
    expect(Object.keys(inv).length).toBeGreaterThan(30);
  });

  it('every file with controls is pinned, and every pinned file still exists', () => {
    expect(Object.keys(inv).filter((f) => !(f in PINS))).toEqual([]);
    expect(Object.keys(PINS).filter((f) => !(f in inv))).toEqual([]);
  });

  it('each file has exactly the pinned controls (a dropped control fails here)', () => {
    const drift: string[] = [];
    for (const [file, pinned] of Object.entries(PINS)) {
      const now = inv[file] ?? {};
      for (const k of new Set([...Object.keys(pinned), ...Object.keys(now)]) as Set<Kind>) {
        if ((pinned[k] ?? 0) !== (now[k] ?? 0)) drift.push(`${file}: ${k} pinned ${pinned[k] ?? 0}, found ${now[k] ?? 0}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('the total is the sum of the pins (so the headline number cannot drift from them)', () => {
    const total = (m: Record<string, Counts>) => Object.values(m).reduce((n, c) => n + Object.values(c).reduce((a, b) => a + (b ?? 0), 0), 0);
    expect(total(inv)).toBe(total(PINS));
  });
});

describe('the 245 rows of the #974 parity table', () => {
  const text = (f: string) => readFileSync(join(SRC, f), 'utf8');

  it('is all 245 rows, each keyed once', () => {
    expect(PARITY_ROWS).toHaveLength(245);
    const keys = PARITY_ROWS.map((r) => r[0]);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('every row still has its control in the file that is its home (a lost row fails here, naming the row)', () => {
    // A row whose needle is the label of interactive elements (min > 0) must still have AT LEAST that many elements with that label in its
    // file, so losing one of two Cancel buttons fails its row. A needle that is code (an identifier, an expression) has min 0 and is a
    // plain substring check.
    const held = (file: string, needle: string, min: number) =>
      existsSync(join(SRC, file)) && (min > 0 ? elementsLabelled(join(SRC, file), needle) >= min : text(file).includes(needle));
    const lost = PARITY_ROWS.filter(([key]) => !(key in REMOVED_ON_PURPOSE)).filter(([, file, needle, min]) => !held(file, needle, min));
    expect(lost.map(([key, file, needle]) => `${key}: ${JSON.stringify(needle)} not found in ${file}`)).toEqual([]);
  });

  it('a row removed on purpose is named with its decision, and is not also claimed present', () => {
    for (const [key, why] of Object.entries(REMOVED_ON_PURPOSE)) {
      expect(why.length).toBeGreaterThan(20);
      expect(PARITY_ROWS.map((r) => r[0])).not.toContain(key);
    }
  });

  it('the controls added since the table are still there', () => {
    const lost = NEW_SINCE_TABLE.filter(([, file, needle]) => !existsSync(join(SRC, file)) || !text(file).includes(needle));
    expect(lost.map(([name]) => name)).toEqual([]);
  });
});

describe('native selects in Settings can only go down (ticket #1191 ruling)', () => {
  const inv = currentInventory();
  it('every file that still has one is named, with what it holds', () => {
    const have = Object.entries(inv).filter(([, c]) => (c.nativeSelect ?? 0) > 0).map(([f]) => f).sort();
    expect(have).toEqual(Object.keys(NATIVE_SELECTS_STILL_IN_SETTINGS).sort());
  });
});

describe('no explanation lives only in a tooltip (ticket #974 rule 5)', () => {
  it('the only title= tooltips on Settings are names for icon-only controls', () => {
    const have: Record<string, number> = {};
    for (const f of settingsFiles()) {
      const n = hoverOnlyTitles(f);
      if (n > 0) have[rel(f)] = n;
    }
    // Before ticket #1190 this also listed webhooks/page.tsx (2: the signing-secret help icon and the delivery error on the status pill)
    // and integrations/github/page.tsx (1: the GitLab placeholder).
    expect(have).toEqual(Object.fromEntries(Object.keys(ALLOWED_TITLE_TOOLTIPS).map((f) => [f, 1])));
  });

  it('the Webhooks signing-secret explanation is text in the dialog, and a failed delivery shows its reason as text', () => {
    const page = readFileSync(join(SETTINGS_DIR, 'webhooks/page.tsx'), 'utf8');
    expect(page).toContain('{SIGNING_SECRET_EXPLAINED}');
    expect(page).toContain('data-testid="webhook-last-error"');
  });
});

/**
 * The 16 rows the table marked "Fixed" each promised a CHANGE, not just a home ("gains a confirm and a toast", "native select -> the shared
 * Select", "not shown on Enterprise", "explanation becomes visible text"). A row that is merely present has not been fixed. Ticket #1190
 * found two promises that never shipped (Account #3's toast, Webhooks #12's explanation); each is named here with what proves it.
 */
const FIXED_ROWS_DELIVERED: ReadonlyArray<readonly [string, string, string]> = [
  ['Account#3 confirm', 'app/w/[ws]/settings/account/page.tsx', 'confirmRemovePhoto()'],
  ['Account#3 the page removes through removeProfilePhoto, passing the toaster', 'app/w/[ws]/settings/account/page.tsx', ', toast);'],
  ['Account#3 the page only clears the photo when the removal succeeded', 'app/w/[ws]/settings/account/page.tsx', 'if (removed) {'],
  ['Account#3 a failed response throws (also driven by remove-photo.unit.test.ts)', 'lib/remove-photo.ts', 'if (!res.ok) throw new Error('],
  ['Account#3 success and failure are told apart', 'lib/remove-photo.ts', 'notify.error(PHOTO_NOT_REMOVED)'],
  ['Account#9 confirm', 'app/w/[ws]/settings/account/page.tsx', 'confirmRevokeSession('],
  ['Members#4 shared Select', 'app/w/[ws]/settings/members/page.tsx', 'label="Role"'],
  ['Members#5 shared Select', 'app/w/[ws]/settings/members/page.tsx', 'label="Access level"'],
  ['Members#12 confirm on a role change', 'app/w/[ws]/settings/members/page.tsx', 'confirmRoleChange('],
  ['Members#13 export is explained on the page', 'app/w/[ws]/settings/members/page.tsx', 'MEMBERS_COPY.exportDescription'],
  ['Members#14 confirm on remove', 'app/w/[ws]/settings/members/page.tsx', 'confirmRemoveMember('],
  ['Members#14 remove is explained on the page', 'app/w/[ws]/settings/members/page.tsx', 'MEMBERS_COPY.removeDescription'],
  ['Members#15 erase is explained on the page', 'app/w/[ws]/settings/members/page.tsx', 'MEMBERS_COPY.eraseDescription'],
  ['Members#21 confirm on revoke', 'app/w/[ws]/settings/members/page.tsx', 'confirmRevokeInvite('],
  ['Billing#2/#3 offered only to a lower plan', 'app/w/[ws]/settings/billing/page.tsx', 'upgradeTargets('],
  ['API tokens#5 confirm for this workspace too', 'app/w/[ws]/settings/api/page.tsx', 'confirmRevokeToken('],
  ['Webhooks#3 signing docs are text', 'app/w/[ws]/settings/webhooks/page.tsx', 'Full signing docs'],
  ['Webhooks#5 confirm on enable/disable', 'app/w/[ws]/settings/webhooks/page.tsx', 'confirmToggleWebhook('],
  ['Webhooks#12 signing secret is explained as text', 'app/w/[ws]/settings/webhooks/page.tsx', '{SIGNING_SECRET_EXPLAINED}'],
  ['Google Calendar#14 confirm on removing a mapping', 'app/w/[ws]/settings/integrations/google-calendar/page.tsx', 'confirmRemoveCalendarMapping('],
];

describe('the rows marked Fixed in the table are fixed, not just present', () => {
  it.each(FIXED_ROWS_DELIVERED)('%s', (_name, file, needle) => {
    expect(readFileSync(join(SRC, file), 'utf8')).toContain(needle);
  });
});

describe('no Settings control is drawn without a handler (a dead Revoke must not pass)', () => {
  it('every Button, menu item, switch and select acts, or is named with a reason', () => {
    const dead: string[] = [];
    for (const f of settingsFiles()) for (const d of handlerless(f)) if (!(`${rel(f)} :: ${d}` in NO_HANDLER_BY_DESIGN)) dead.push(`${rel(f)} :: ${d}`);
    expect(dead).toEqual([]);
  });
  it('the scanner sees a Revoke whose onClick was removed (self-test)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-'));
    const f = join(dir, 'x.tsx');
    writeFileSync(f, 'export const A = () => (<div><Button size="sm">Revoke</Button><Button onClick={go}>Ok</Button><form><Button type="submit">Save</Button></form><DialogClose asChild><Button>Close</Button></DialogClose></div>);');
    expect(handlerless(f)).toEqual(['Button "Revoke"']);
  });
});
