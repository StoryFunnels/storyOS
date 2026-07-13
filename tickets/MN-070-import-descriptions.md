---
id: MN-070
title: Import descriptions — Linear issue/project bodies become record documents
status: done
depends_on: [MN-066]
size: M
---

MN-066 imported the tracker structure but skipped narrative: Linear issue and project **descriptions** (markdown) never came across, so imported records have empty entity-page descriptions. On the live instance that's the missing half — the "why" behind each issue. Close it, and lay the groundwork the the reference tool importer can reuse.

## Design
- Add `description` to the Linear GraphQL issue + project queries.
- Server-side `markdownToBlocks(md)` → BlockNote block JSON (headings, bold/italic/code, links, bullet/numbered lists, code fences, blockquotes, hr, paragraphs). Lives in `apps/api/src/integrations/markdown-to-blocks.ts` (reusable by other importers).
- LinearService writes the description via DocumentsService **only when the record has no document yet** (current version 0) — newly imported records get their body; re-imports never clobber a description edited in StoryOS.
- Empty/whitespace descriptions write nothing.

## Acceptance criteria
- [x] Imported issues/projects show their Linear description on the entity page, formatted (headings, lists, links, code)
- [x] Re-import fills a missing description but never overwrites an edited one
- [x] markdownToBlocks unit-tested; Linear import test asserts a document is written with converted blocks
