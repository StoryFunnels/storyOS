# This directory is internal

`docs/product/` holds vision documents, ticket companions, and specs written **for the team
building StoryOS** — not for a person using it. Nothing here is served by any public site.

**If you are writing a page a user or self-hoster should be able to read, it does not go here.**
Write it in [`apps/docs/src/content/docs/`](../../apps/docs/src/content/docs/) instead — that tree
is the Starlight site published at [docs.storyos.dev](https://docs.storyos.dev). Put a product
how-to under `concepts/` or `guides/`, matching whichever existing page it's closest to.

## Why this file exists

For two weeks (2026-08-20 onward), product documentation was written into this directory instead —
16 pages, real work, genuinely merged, and none of it ever reachable by a reader, because this tree
and the published site share the word "docs" and nothing distinguished them. The single worst
instance: a page was rewritten specifically to correct four claims that had gone false, and the
correction never reached anyone, because the corrected page lived here instead of on the site.

That work has since been moved to `apps/docs/`. This file is what stops it from happening again.

## What still belongs here

Planning and vision documents with no reader-facing form yet: `vision.md`, `v1-scope.md`,
`user-stories.md`, `use-cases.md`, `flows.md`, `agentic-vision.md`, `mcp-plan.md`, `cogs-model.md`,
`website-plan.md`, `template-research.md`, `templates.md`, `template-library.md`. These are written
for whoever builds the next feature, not whoever uses this one — ticket references, MUST/SHOULD/
LATER tags, and founder directives are the tell.

If a page in this directory starts reading like something a user should be able to find, that's
the sign it's ready to move, not a reason to leave it here because it's convenient.
