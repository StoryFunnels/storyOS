---
id: MN-041
title: Rich Text field type — clearly separated from plain Text
status: todo
depends_on: [MN-025]
size: M
---

**Problem (founder, 2026-07-09):** "Text" currently stretches from a one-line string to `multiline`, and there is no formatted-text field at all. Users expect a clear split: **Text** = simple string, **Rich Text** = real formatting (headings, lists, bold, links).

**Research.** Notion: "Text" properties are plain; rich content lives in the page body — but users constantly ask for rich text properties. Fibery: distinct "Text" (plain) and "Rich Text" (collaborative doc) field types; rich text renders as a block on the entity view, and as a plain-text preview in grids. Airtable: "Long text" with an *Enable rich text formatting* toggle; grid shows a stripped preview, expanded record shows the editor. Consensus: **rich text edits on the entity view with a real editor, grids show a read-only plain preview**.

**Design.**

- New creatable type `rich_text`. Value = BlockNote document JSON (same editor as record descriptions; consistent authoring). Validator: must be an array of blocks, size-capped (64KB).
- Entity page: the property renders as a full-width block *section* under the properties panel (like Description) with an inline BlockNote editor — not squeezed into the 40px property row. Property row itself shows a preview + jumps focus to the section.
- Table cell: read-only plain-text preview (first ~200 chars extracted from the JSON); clicking the cell selects it, opening the record is the edit path (Airtable model).
- Type picker: "Text — a short plain string" vs "Rich text — formatted content with headings and lists"; `multiline` stays on Text for tall-but-plain strings.
- Conversions: `text → rich_text` (wrap in one paragraph block), `rich_text → text` (extract plain text, lossy warning via existing dry-run flow).

## Acceptance criteria

- [ ] `rich_text` creatable via API + UI; values validated as BlockNote JSON with a size cap
- [ ] Entity page renders a BlockNote editor per rich_text field (editor+ access), saving on blur/debounce
- [ ] Table cells show a plain-text preview and are not inline-editable
- [ ] text ↔ rich_text conversions work through the change-type flow incl. dry-run counts
- [ ] Integration tests: create, write/read, validator rejects non-block JSON and oversize, both conversions
