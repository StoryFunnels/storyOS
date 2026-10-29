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

## Using StoryOS alongside Linear

If Linear stays your team's tracker and StoryOS is where agents and the rest of the work live, this
is the whole contract. Details for each line follow below.

| | What | When |
|---|---|---|
| **Linear → StoryOS** | Teams, issues, cycles, projects, labels, workflow statuses and comments, written into the mirrored space. | When you press **Import**, and on the schedule if an admin turned it on. |
| **StoryOS → Linear** | **Comments only**, and only if an admin turned write-back on. Each is signed `<author> · via StoryOS`. | A comment is queued once, picked up within about a minute, and retried only if delivery fails (30 seconds, 2 minutes, 10 minutes, 1 hour, then it is marked as not delivered). |
| **Everything else** | Nothing. The only thing the write-back writes to Linear is a new comment; it never edits an issue's title, status, assignee or any other field. (A retry also reads the issue's comments, see below.) | |

- **Linear owns the fields it maps.** Every sync writes them again from Linear (the exact list is
  under [What a sync overwrites, and what it never writes](#what-a-sync-overwrites-and-what-it-never-writes)),
  so an edit to one of them in StoryOS is replaced by what Linear says the next time that issue is
  read.
- **StoryOS keeps what it added.** A field you or an agent add to the Issues database, and an issue's
  description, are not written by the sync once the description exists.
- **A description that changes in Linear is flagged, not overwritten** (see below).

## How to run it

1. In Linear: **Settings → Security & access → API keys** → create a personal API key.
2. In StoryOS: **Settings → Integrations → Linear** (admin only) — paste the key,
   optionally list team keys (`ENG, OPS`) to import a subset. Empty = all teams.
3. Hit **Preview import** — you get counts per team and per Linear project (including issues with
   no project), next to Linear's own total for the team, and nothing is written. If the counts
   don't match Linear's, the preview refuses and shows both numbers rather than a number you can't
   trust. While a sync is running, Preview answers at once that it would only compete with the
   sync and asks you to try again when it finishes, instead of waiting behind it. A second Preview is refused while one is running.
4. Hit **Import**. Re-run any time to pick up changes made in Linear since. A manual Import reads
   everything from Linear, and is refused while another sync is running.

### Keeping it in sync

Everything below is **off until an admin switches it on**, on the same Linear page.

- **Scheduled re-sync.** A switch and an interval (15 minutes to 24 hours, 60 minutes by default).
  A run is due one interval after the previous attempt, so a failing run is retried each interval,
  not every minute. To keep runs short, a scheduled run reads only the issues and comments Linear
  changed since the last successful run (starting five minutes earlier, to absorb clock
  differences), plus the small lists of labels, cycles, projects and statuses in full. It does a
  **full read at least once a day**, and whenever there is no earlier success to build on or the
  list of teams has changed. The admin who switches it
  on is the person the scheduled runs write as. The page shows the health
  of the mirror: last success, last attempt, failures in a row, the last error, when the next
  run is due, and how many issues and comments the last run read and how long it took. If it has not succeeded for two intervals it says **"This mirror has stopped
  updating"**, the Integrations list shows a **Not updating** chip, and the first failure of a
  streak notifies the admin who enabled it.
- **Comment write-back.** When on, a comment written in StoryOS on a mirrored issue is posted to
  the Linear issue as a comment, signed `<author> · via StoryOS` (the agent's name when an agent
  wrote it). Only comments created **after** you switch it on are sent, and it never sends
  anything but comments. It posts under the identity of the connected API key, which therefore
  needs permission to write comments; the page asks you to confirm this before it turns on. A
  comment that can't be delivered after five attempts is marked as such on the comment itself, and
  the page counts those still waiting and those given up on. Every pushed comment ends with a small marker line naming the StoryOS comment it came from (`storyos-comment-<id>`), visible in Linear under the text. Before any retry (a send cut off by a server stop, or one whose answer was lost), StoryOS reads the Linear issue's comments and looks for that marker. If it finds the comment, it records it as sent and does not send it again. If that lookup itself fails, the comment waits for its next retry rather than being sent blind. The comment you wrote in StoryOS is never imported back as a second copy.
- **Edited descriptions are flagged, not overwritten.** If an issue's description changes in
  Linear after it was imported, StoryOS keeps the description it has, stores Linear's new text in
  the **Linear Description** field and ticks **Description Drift**. **Linear Description** is
  hidden on the record page, because beside the editable description it would show the same text
  twice. When the flag is ticked, the record page shows one line, "Linear's description changed
  since import", with a **View Linear's text** button; the hidden field stays readable over the API
  and MCP and in table views. Clearing the **Description Drift** checkbox sticks until Linear's
  text changes again. If the record already had a description but StoryOS had never recorded
  Linear's text (an older import), the first sync records it as the baseline and does not flag.
  An Issues database from an older import gets the field hidden once; if you show it again, a later
  sync does not hide it again.
- **Issues that leave Linear are marked, not deleted.** An issue that is archived, deleted or
  moved out of the imported teams gets a **Linear Status** reading *Left Linear scope (archived,
  deleted or moved)* with the date. The sync deletes no issue. It un-marks itself if the issue
  comes back. Only a full read can see that an issue has gone, so on a schedule this can take up
  to a day to show.

### What a sync overwrites, and what it never writes

This is read from the sync code, not from a rule about agents: nothing in the sync checks who last
edited a field, so it does not stop an agent or a person from editing any field in StoryOS. What it
does is below.

**Written again from Linear on every issue the sync reads:** Name, Identifier, State, Linear Status,
Priority, Assignee (name), Estimate and URL, plus Linear ID on first creation. A value cleared in
Linear (no priority, no assignee, no estimate) is written as empty. So an edit in StoryOS to one of
those fields lasts only until Linear's copy of that issue is next read (on a scheduled run, an
issue Linear has not changed is not read, so it is not rewritten until the daily full read).

**Set to Linear's, on every issue the sync reads:** the Labels, Sprint, Project and Parent Issue
links. A label dropped, or a cycle, project or parent changed or cleared in Linear, is unlinked in
StoryOS on that issue's next read, and a link someone added in StoryOS that Linear does not have is
removed with it. The exception is a link Linear reports to something that was not imported (for
example a parent outside the chosen teams): the existing link is left as it was rather than
cleared. A record whose links already match is not written again.

**Not written by a sync once they exist:**

- The record's **description**. It is written only when the record has none yet.
- Any field that is not in the first list, including fields you or an agent add to the Issues
  database.
- Comments already imported, and everything written to Linear (see *Comment write-back*).

**Description Drift** is the one bookkeeping flag the sync writes. It ticks it when Linear's text changed, and leaves it unticked on a new record or one whose description is still blank. It does not untick a flag on a record that has a description.

State options: each sync adds an option for every Linear status, keeps Linear's order, and sets the
option's category (backlog, unstarted, started, completed or canceled) from the status type Linear
reports. It adds options and never deletes them.

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
| Project state | State select under the names Linear shows: backlog → Backlog, planned → Planned, started → In Progress, paused → Paused, completed → Completed, canceled → Canceled, coloured like Linear's (gray, blue, gold, orange, green, red in that order). A database imported earlier keeps its raw-named options as they are; the sync still matches them. |
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
  comments. On a full read (a manual Import, a Preview, and the first and daily
  scheduled runs) it compares what it read with Linear's own issue count for each team before it
  writes anything, and a mismatch fails with a message naming both numbers, so a short copy never
  lands. All teams are checked before any are written. A scheduled run that reads only changes has no
  total to compare with, so it skips that count check; the daily full read is the one that checks.
- **A status the team's workflow does not list fails the read**, again before anything is written.
- **An issue with more than 50 labels fails the read** rather than losing labels.
- **Re-running over an older import** adds your Linear statuses as State options in Linear's order and
  keeps the old ones (*To Do*, *In Review* and so on) after them; it never deletes options.
- Edits to a StoryOS comment after it was written back, and deleting it, are not carried to Linear.
