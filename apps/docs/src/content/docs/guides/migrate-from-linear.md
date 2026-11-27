---
title: Migrate from Linear
description: Import your Linear workspace through the Linear GraphQL API, then optionally keep it in sync on a schedule and write StoryOS comments back. Teams become spaces; issues, sprints, projects, comments, GitHub pull request links, other attachments and project documents come across with a full field mapping table.
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
| **Linear → StoryOS** | Teams, issues, cycles, projects, labels, workflow statuses, comments, attachments (GitHub pull request links and other links) and project documents, written into the mirrored space. | When you press **Import**, and on the schedule if an admin turned it on. |
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
- **Comment write-back.** When on, a comment a person or an agent wrote in StoryOS on a mirrored
  issue is posted to the Linear issue as a comment, signed `<author> · via StoryOS` (the agent's
  name when an agent wrote it). Only comments created **after** you switch it on are sent, and it
  never sends anything but comments. **A comment StoryOS writes itself is never sent**: an
  approval's decision or expiry note (so a rejection reason stays in StoryOS), a note about a run
  or a delegation, a comment an automation wrote, the note on a duplicated record, a comment
  imported from Linear, and any comment whose origin was not recorded. It posts under the identity of the connected API key, which therefore
  needs permission to write comments; the page asks you to confirm this before it turns on. A
  comment that can't be delivered after five attempts is marked as such on the comment itself, and
  the page counts those still waiting and those given up on. An admin can also have a comment an agent wrote held for approval before it is posted: see [holding an agent's comment before it reaches Linear](/concepts/approval-gates/#holding-an-agents-comment-before-it-reaches-linear). Every pushed comment ends with a small marker line naming the StoryOS comment it came from (`storyos-comment-<id>`), visible in Linear under the text. Before any retry (a send cut off by a server stop, or one whose answer was lost), StoryOS reads the Linear issue's comments and looks for that marker. If it finds the comment, it records it as sent and does not send it again. If that lookup itself fails, the comment waits for its next retry rather than being sent blind. The comment you wrote in StoryOS is never imported back as a second copy.
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

**Attachments and documents** (see [Attachments and project documents](#attachments-and-project-documents)):
a Links record's Name, URL, Source Type and Subtitle, and its link to the issue, are written again from
Linear on every read of that issue. A pull request record is created when it is missing and **never
rewritten from a Linear attachment**, and its link to an issue is only ever added. A Documents record's
Name, Author (name), dates, URL and Project link are written again; its **body is written only while the
record has none** (a later change in Linear is flagged, not applied).

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
| Attachment whose URL is a GitHub pull request | A record in the workspace's **GitHub Pull Requests** database, found by repository **and** number, linked to the issue |
| Any other attachment (merge commit, Figma file, ...) | A record in the team's **Links** database (title, URL, source type, subtitle) with an Issue relation |
| Project document | A record in the team's **Documents** database (title, author name, Linear created and updated, URL), related to its project; the Markdown is the record's description |
| Issue ID (internal) | Linear ID text field — the idempotency key; don't edit it |

## Attachments and project documents

**What an attachment is comes from its URL, never from Linear's label.** Anyone can attach any URL to an
issue, so a `github` label proves nothing, and a pull request pasted by hand has no label at all.

- An **https URL on github.com shaped `/owner/repo/pull/N`** is a pull request. It becomes a record in the
  **GitHub Pull Requests** database (the one the [GitHub integration](/guides/github/) fills), found by
  repository and number together: the same number in another repository is another pull request. The record
  is linked to the issue through the same *Linked Record* relation the GitHub webhook uses, so when GitHub
  later sends that pull request, the webhook updates this record instead of creating a second one. The same
  pull request on two issues is one record linked to both. If the record already exists (from the webhook or
  an earlier run) it is not changed; a new one gets Linear's title, repository, number and canonical URL, and
  a state only when Linear's attachment names one (otherwise the state stays empty until GitHub reports it).
  Linking a pull request never removes another link, and an attachment deleted in Linear does not unlink it.
- **Any other http(s) URL** (a merge commit, a Figma file, a GitHub Enterprise pull request, a pull request
  on `http://`) becomes a record in the team's own **Links** database, keeping Linear's title, URL, source
  type and subtitle, with an **Issue** relation. Re-running updates it by its Linear id. An attachment
  deleted in Linear is not deleted here.
- A URL that is **not http(s)** (`javascript:`, `data:`, `file:`), is not a URL, or is over 2,048 characters
  is **not imported**. It is counted as `unusable` and named in the run's warnings.
- **A URL is data and is never opened.** The import does not fetch, follow or preview any attachment URL.
- An attachment on an issue the run did not place (the issue was created after the run read the team) is
  counted as `unplaced` and picked up by the next run. A write that fails is counted as `failed` and named,
  and does not stop the sync.

**A restricted team keeps its pull requests to itself.** The GitHub Pull Requests database lives in the GitHub
space, which can be open to people the team's space is not. If the team's space or its Issues database is
[restricted](/concepts/access-and-roles/), its pull request attachments are **not** written there: they go to the team's own
Links database instead (counted as `kept_in_team_space`), which is as private as the team's space. Pull
request records written while the space was still open stay where they are.

**Documents.** A Linear project document becomes a record in the team's **Documents** database, related to its
project, with its Markdown as the record's description (headings, lists, links and code kept). The Documents
database sits inside the team's space, so the document is visible to exactly the people who can see the
team's issues, never to more. A project that spans teams brings its documents into each team's database.
Rules that follow from this:

- Only documents attached to a **project** are imported. Documents attached to an issue, an initiative or
  nothing are counted as `no_project`; documents of a project that is in none of the imported teams as
  `project_not_imported`. Neither is dropped silently.
- The body is written **only while the record has no description**. If the text in Linear changes later,
  StoryOS keeps what it has and ticks **Changed in Linear** on the record; clearing the box sticks until Linear
  changes the text again. (The sync compares a hash; it keeps no second copy of the text.)
- A body over **2 MB** is not truncated: the record is created without a body and the document's title is
  listed in `oversize` and in the warnings.
- The author is kept as Linear's name, in **Author (name)**, not matched to a member. Linear's created and
  updated times are kept in **Linear Created** and **Linear Updated**; the record's own created time is the
  import's.
- The importer recognises its own databases by a hidden `Linear ID` field, not by name. If someone already made
  a database called **Documents** or **Links** in the team space, the importer leaves it alone and uses
  **Documents (Linear)** or **Links (Linear)**.

**Counts.** The sync response reports `attachments` (fetched, pull_requests, pr_records_created, links,
kept_in_team_space, unusable, unplaced, failed) and `documents` (fetched, placed, copies, created, body_written,
drift_flagged, no_project, project_not_imported, oversize, failed). Every attachment and every document lands
in exactly one bucket, and the sync fails if the buckets do not add up to what was read. **Preview** shows, per
team, how many attachments would become pull request records, links or unusable, and how many documents are
importable. Linear reports no total for either, so unlike issues these counts are not checked against a figure
from Linear.

A scheduled run that reads only what changed reads the attachments of the issues Linear changed since the last
success; the daily full read covers the rest, so a pull request attached without touching the issue can take up
to a day to appear.

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
