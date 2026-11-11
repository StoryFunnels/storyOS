# Claims: what we may say publicly

The claims register in the StoryOS library (storyos/docs #7, "StoryOS — Claims Register") is the only source for what we may say about the product. It is owned by marketing and kept current there. This repo does not copy it, because a copy goes stale and this repo is public.

The rules that do not change:

- A public claim must be live in production, not only merged to main. Re-check against current production before you use a claim. (Source: register #7, 'Rulings added 2026-10-24'.)
- Check every public sentence about the product against the register before you write it. When any page and the register disagree, the register wins. (Source: register #7, header.)
- Say "can hold actions" about approvals, never "all". (Source: register #7, 'Re-check 2026-11-11'.)
- A switched-on pack agent drafts; gated actions wait for a person. Make no public claim that it wakes by itself until that is verified in production. (Source: Theo, head of marketing, register update, 2026-11-11, after ticket #1212.)
- "Ever" and "never cap" are promises about the future and are Ievgen's call. (Source: register #7, 'Plan and API claims'.)

Agents read the register through the StoryOS library (database `storyos/docs`, record 7). If you cannot reach it, do not guess a claim: leave it out and ask.

See also [values.md](values.md) and [voice.md](voice.md).
