---
title: Migrate from Linear
description: Import your Linear workspace through the Linear GraphQL API, then optionally keep it in sync on a schedule and write StoryOS comments back. Teams become spaces; issues, sprints, projects and comments come across with a full field mapping table.
sidebar:
  order: 4
---

StoryOS imports your Linear workspace via the Linear GraphQL API — no CSV gymnastics, no
webhooks. Each team becomes a space shaped like our **Dev Project** pack. The import is
idempotent: every record carries its Linear ID, so re-running updates records in place instead of
duplicating them. That is also what makes it a **mirror**, not a one-off: you can run it again by
hand, switch on a schedule so it re-syncs by itself, and optionally write comments made in StoryOS
back to Linear.

## How to run it

1. In Linear: **Settings → Security & access → API keys** → create a personal API key.
2. In StoryOS: **Settings → Integrations → Linear** (admin only) — paste the key,
   optionally list team keys (`ENG, OPS`) to import a subset. Empty = all teams.
3. Hit **Preview import** — you get counts per team and per Linear project (including issues with
   no project), next to Linear's own total for the team, and nothing is written. If the counts
   don't match Linear's, the preview refuses and shows both numbers rather than a number you can't
   trust.
4. Hit **Import**. Re-run any time to pick up changes made in Linear since.

### Keeping it in sync

Everything below is **off until an admin switches it on**, on the same Linear page.

- **Scheduled re-sync.** A switch and an interval (15 minutes to 24 hours, 60 minutes by default).
  The admin who switches it on is the person the scheduled runs write as. The page shows the health
  of the mirror: last success, last attempt, failures in a row, the last error and when the next
  run is due. If it has not succeeded for two intervals it says **"This mirror has stopped
  updating"**, the Integrations list shows a **Not updating** chip, and the first failure of a
  streak notifies the admin who enabled it.
- **Comment write-back.** When on, a comment written in StoryOS on a mirrored issue is posted to
  the Linear issue as a comment, signed `<author> · via StoryOS` (the agent's name when an agent
  wrote it). Only comments created **after** you switch it on are sent, and it never sends
  anything but comments. It posts under the identity of the connected API key, which therefore
  needs permission to write comments; the page asks you to confirm this before it turns on. A
  comment that can't be delivered after five attempts is marked as such on the comment itself, and
  the page counts those still waiting and those given up on.
- **Edited descriptions are flagged, not overwritten.** If an issue's description changes in
  Linear after it was imported, StoryOS keeps your description, stores Linear's new text in a
  hidden **Linear Description** field and ticks **Description Drift** so you can see what needs a
  look. Clearing the flag sticks until Linear's text changes again.
- **Issues that leave Linear are marked, never deleted.** An issue that is archived, deleted or
  moved out of the imported teams gets a **Linear Status** reading *Left Linear scope (archived,
  deleted or moved)* with the date. It un-marks itself if the issue comes back.

## What maps to what

| Linear | StoryOS |
|---|---|
| Team | Space `"<Team name> (Linear)"` with Issues + Sprints + Projects databases |
| Issue | Record in **Issues** |
| Issue title / identifier / URL | Name / Identifier / URL |
| Issue / project description (markdown) | Record description (rich text) — headings, lists, links, code preserved. Only written when the record has no description yet, so re-imports never overwrite edits. |
| Workflow state | **State** select with **your team's own Linear statuses**, named as in Linear and in Linear's order, so *Ready For Staging* and *Deployed* stay distinct. The status name is also kept in a **Linear Status** text field. |
| Priority (1–4) | Priority select: Urgent / High / Medium / Low (no priority → empty) |
| Labels | **Labels database** (name + color) with a many-to-many relation on Issues — reusable, filterable, colorable. Idempotent by Linear label id. |
| Estimate | Estimate (number) |
| Assignee | **Assignee (name)** — plain text. Users aren't matched automatically: invite your team first, then reassign. Nothing is lost. |
| Parent / sub-issues | Parent Issue self-relation (Sub-issues on the other side) |
| Cycle | Record in **Sprints** (number, start/end dates) + Sprint relation on the issue |
| Project | Record in **Projects** (state, target date, URL) + Project relation on the issue |
| Issue ID (internal) | Linear ID text field — the idempotency key; don't edit it |

## Comments

Comments come across as native StoryOS comments on each record, so they show where people already
look. Each opens with a header naming the Linear author (or the bot or external user), the time and
*(from Linear)*, keeps its original timestamp, and ends with a link to the original comment. They
are marked as not written by a person, and importing them sends no notifications. Reactions, file
attachments (images stay as links), @mentions as StoryOS mentions, reply threading and later edits in
Linear are not carried: comments are flat, in time order, and a comment already imported is not
updated.

## What is intentionally NOT imported

- **Members** — deliberate. Assignee names are preserved as text so nothing
  silently maps to the wrong account.

## Limits

- **Everything is paged to the end.** There is no per-team ceiling on issues, cycles, projects or
  comments. Before the import writes anything it compares what it read with Linear's own issue
  count for each team, and a mismatch fails with a message naming both numbers, so a short copy never
  lands. All teams are checked before any are written.
- **A status the team's workflow does not list fails the read**, again before anything is written.
- **An issue with more than 50 labels fails the read** rather than losing labels.
- **Re-running over an older import** adds your Linear statuses as State options in Linear's order and
  keeps the old ones (*To Do*, *In Review* and so on) after them; it never deletes options.
- Edits to a StoryOS comment after it was written back, and deleting it, are not carried to Linear.
