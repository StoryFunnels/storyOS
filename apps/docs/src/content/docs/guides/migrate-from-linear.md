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
| **Linear → StoryOS** | Teams, issues (with Linear's own numbers, dates and status history), cycles, projects, project milestones, labels, workflow statuses, people, comments, attachments (GitHub pull request links and other links) and project documents, written into the mirrored space. | When you press **Import**, and on the schedule if an admin turned it on. |
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
Priority, **Assignee** and Assignee (name), Estimate, URL, **Started**, **Completed** and **Due Date**, plus
Linear ID on first creation. The record's own **created and last-updated times** are set to Linear's
too, and so is the imported **State history** (see below). A value cleared in
Linear (no priority, no assignee, no estimate, no due date) is written as empty. So an edit in StoryOS to one of
those fields lasts only until Linear's copy of that issue is next read (on a scheduled run, an
issue Linear has not changed is not read, so it is not rewritten until the daily full read).

**Set to Linear's, on every issue the sync reads:** the Labels, Sprint, Project, Milestone and Parent Issue
links, and the six relation fields (Blocked by, Blocks, Duplicate of, Duplicates, Related, Related to; see
[Relations](#relations)). A label dropped, or a cycle, project or parent changed or cleared in Linear, is unlinked in
StoryOS on that issue's next read, and a link someone added in StoryOS that Linear does not have is
removed with it. The exception is a link Linear reports to something that was not imported (for
example a parent outside the chosen teams): the existing link is left as it was rather than
cleared. A record whose links already match is not written again.

**Milestones** are written the same way: Name, Target Date, Sort Order and the Project link are
set to Linear's on every sync (a milestone's description is written only while it has none, like a
project's). A milestone that Linear no longer returns (deleted or archived there) is **kept** and
named in the run's warnings, never deleted. An issue that names a milestone the read did not return
keeps the link it had, and the run counts it and says so.

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

**State history** is replaced as a set on every issue the sync reads: the rows the importer wrote (marked
as an import) are rewritten from Linear's history, and every row a person, an agent or an automation wrote is left alone.

**Description Drift** is the one bookkeeping flag the sync writes. It ticks it when Linear's text changed, and leaves it unticked on a new record or one whose description is still blank. It does not untick a flag on a record that has a description.

State options: each sync adds an option for every Linear status, keeps Linear's order, and sets the
option's category (backlog, unstarted, started, completed or canceled) from the status type Linear
reports. It adds options and never deletes them. A **Duplicate** option that has no category is given
`canceled` (the type Linear documents for its Duplicate status), whether or not the team's workflow still
lists a Duplicate status; the sync summary says which it was.

## What maps to what

| Linear | StoryOS |
|---|---|
| Team | Space `"<Team name> (Linear)"` (or the name you chose, see [Choosing a team's space](#choosing-a-teams-space)) with Issues + Sprints + Projects + Milestones databases. A **private** team gets a **restricted** space, see [Private teams](#private-teams). |
| Issue | Record in **Issues**, numbered with Linear's own number where the database allows it (see [Numbers and identifiers](#numbers-and-identifiers)) |
| Issue created / updated | The record's own created and last-updated times: Linear's, not the day of the import |
| Issue started / completed / due | **Started**, **Completed** and **Due Date** date fields (the day, in UTC) |
| Issue history (state changes) | Rows in the record's field history on **State**, at their real times, marked as an import, with the person as the actor when they match a member |
| Issue title / identifier / URL | Name / Identifier / URL |
| Issue / project description (markdown) | Record description (rich text) — headings, lists, links, code preserved. Only written when the record has no description yet, so re-imports never overwrite edits. |
| Workflow state | **State** select with **your team's own Linear statuses**, named as in Linear and in Linear's order, so *Ready For Staging* and *Deployed* stay distinct. The status name is also kept in a **Linear Status** text field. |
| Priority (1–4) | Priority select: Urgent / High / Medium / Low (no priority → empty) |
| Labels | **Labels database** (name + color) with a many-to-many relation on Issues — reusable, filterable, colorable. Idempotent by Linear label id. |
| Estimate | Estimate (number) |
| Assignee | The workspace **member with the same email** goes in the **Assignee** person field. Someone who matches no member is kept by name in **Assignee (name)** and listed in the import report, never dropped. See [People](#people). |
| Parent / sub-issues | Parent Issue self-relation (Sub-issues on the other side) |
| Issue relations | Self relations on **Issues**: **Blocked by** / **Blocks**, **Duplicate of** / **Duplicates**, **Related** / **Related to**. See [Relations](#relations). |
| Cycle | Record in **Sprints** (number, start/end dates) + Sprint relation on the issue |
| Project | Record in **Projects** (state, target date, URL) + Project relation on the issue |
| Project milestone | Record in **Milestones** (a database in the team's space, beside Projects) with Name, Target Date, Sort Order (Linear's own order) and the description as the record body, linked to its **Project** (a project's Milestones are listed on the project). An issue's milestone becomes its **Milestone** link. A mirror imported before this gains the Milestones database on its next sync. |
| Project state | State select under the names Linear shows: backlog → Backlog, planned → Planned, started → In Progress, paused → Paused, completed → Completed, canceled → Canceled, coloured like Linear's (gray, blue, gold, orange, green, red in that order). A database imported earlier keeps its raw-named options as they are; the sync still matches them. |
| Attachment whose URL is a GitHub pull request | A record in the workspace's **GitHub Pull Requests** database, found by repository **and** number, linked to the issue |
| Any other attachment (merge commit, Figma file, ...) | A record in the team's **Links** database (title, URL, source type, subtitle) with an Issue relation |
| Project document | A record in the team's **Documents** database (title, author name, Linear created and updated, URL), related to its project; the Markdown is the record's description |
| Issue ID (internal) | Linear ID text field — the idempotency key; don't edit it |

## Relations

An issue's relations to other issues of the **same team** come across as self relations on that team's Issues
database, created on the first sync that reads them (an older mirror gets them added in place):

| Linear | StoryOS fields |
|---|---|
| A blocks B | A's **Blocks** holds B; B's **Blocked by** holds A (many to many) |
| A is a duplicate of B | A's **Duplicate of** holds B; B's **Duplicates** holds A (an issue is a duplicate of one issue) |
| A is related to B | A's **Related** holds B; B's **Related to** holds A |

- **Linear owns these links**, like labels, cycle, project and parent: each sync sets an issue's six fields to
  what Linear says, so a relation removed in Linear is removed here, and a link a person added in StoryOS that
  Linear does not have is removed on that issue's next read. Linear's *related* link has one direction, so StoryOS
  shows it under **Related** on one issue and **Related to** on the other; look in both. Nothing changes on a sync
  of an unchanged issue.
- **`similar` is not imported.** Linear's *similar* is its own suggestion engine, not a decision a person made.
  A relation of a type this importer does not know is not imported either, and is named in the sync summary.
- **Relations between two teams are not imported yet.** Each team is its own space with its own Issues database,
  so such a link would need a relation across two databases. The sync does not link them and does not hide them:
  the summary counts them per team pair (for example `SF→ISSUE: 12`), says so in its warnings, and the
  preview shows the same counts before anything is written, never a title or an identifier. If that share turns out to be large, one relation per team pair that actually occurs is the follow-up.
- **A relation to an issue that is not in the mirror** (not read, or in a team you did not import) is counted and
  named in the warnings, not linked. An issue marked a duplicate of more than one issue links the first only.
- **Existing fields.** The sync recognises the fields it created by a marker, not by name. A "Blocked by" /
  "Blocks" (or the other pairs) self relation of exactly the right shape that someone built by hand is adopted,
  so you do not get a second pair. A field that holds one of these names but is not that shape is left alone, and
  the pair is skipped with a warning.
- **Reads.** Relations are read in their own query, 25 issues at a time. An issue with more than 50 relations in
  one direction, or a relation list Linear does not say is complete, fails the read, and a full read must cover
  every issue the issue read returned. A scheduled run reads relations only for issues Linear changed since the
  last run; whether Linear marks both issues as changed when a relation is added is not verified, so the daily
  full read is what corrects a miss.
- **Access.** The links are ordinary relation links. A person who can read an issue sees a linked issue only if
  they can read that one too, as with any relation.
- **Moving an issue to Duplicate.** In Linear, marking an issue a duplicate moves it to the Duplicate status.
  While Linear is the source, StoryOS reads the status Linear gives the issue and does not move it. Making StoryOS
  do that once it owns the issues is not built yet and is tracked as ticket #1387.

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
  If the workspace has no GitHub pack yet, the first pull request attachment creates it: a **GitHub** space
  with the **GitHub Issues** and **GitHub Pull Requests** databases, exactly as connecting GitHub would (no
  connection to GitHub is made).
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
look. A comment whose Linear author has the same email as a workspace member is written **as that
member**. Anyone else (a bot, an external user, a person who is not a member) is written under the
importing account, and the comment opens with a header naming the Linear author, the time and
*(from Linear)*. Either way it keeps its original timestamp and ends with a link to the original
comment. They are marked as not written by a person, and importing them sends no notifications.
If the author joins the workspace later, the next run **re-authors** the comment already imported as them: it
never imports it a second time. Reactions, file
attachments (images stay as links), @mentions as StoryOS mentions, reply threading and later edits in
Linear are not carried: comments are flat, in time order, and a comment already imported is not
updated.

## People

Linear people are matched to workspace members **by email address, and by nothing else**. A display name
is not an identity: two people share one, and one person changes theirs.

- A matched assignee goes in the **Assignee** person field and **Assignee (name)** is cleared.
- A person who matches no member is not guessed at and not dropped: the issue's **Assignee** is empty, their
  name is kept in **Assignee (name)**, and the import report lists every one of them with their email and how
  many issues (or comments) they have. Invite them, run the import again, and they are matched.
- **Invite your team before the first import.** Matching happens against who is in the workspace when the run
  reads it. Guests count as members.
- This needs Linear to return people's emails to your API key. If it does not, nothing matches and the report
  says so.

## Numbers and identifiers

A database can carry an identifier prefix (see [Identifiers](/concepts/record-identifiers/)). On a **fresh** import
the Issues database is written under **Linear's own numbers**, so the record Linear calls `ISSUE-5201` is
number 5201 and answers to `ISSUE-5201` here, and records made in StoryOS afterwards continue after the highest
imported number. The team key becomes the prefix.

- If another database in the workspace already holds that prefix, it is **not** taken: the report names the
  holder, the issues keep Linear's numbers, and an admin can set a prefix on the Issues database once one is free.
- If a record already holds a number Linear's issue needs (a hand-made one), the import **stops and names
  it**. It never overwrites or renumbers a record.
- **A mirror made before this existed is not renumbered.** Its records were numbered in import order, which does
  not match Linear's numbers, so a sync keeps them as they are, says so in the report, and sets no prefix
  (the identifier would be wrong with confidence). To get Linear's numbers, import into a new space or workspace.

## Choosing a team's space

By default each team lands in a space named `"<Team name> (Linear)"`. In the Linear settings an admin can give a
team key its own space name (used when the space is created) or point it at an existing space. Once a team has
a space, the sync remembers it **by id**, so renaming the space later does not lose it and does not create a
second one.

## Private teams

A private team in Linear is imported only where an admin has switched **private teams** on for the workspace.
While it is off, a sync that includes a private team is refused before anything is read or written, naming the team.
A workspace's admins can see restricted content, so only switch it on in a workspace set up for that team.

- The team's space is created **restricted**, before the first record is written into it, and its members (matched
  by email) are granted editor access. Anyone else, including other members and guests, does not see the space,
  its databases or its records. The members who could not be matched are listed in the report and get nothing.
- A space that already exists open for a team that is now private is **restricted first**, before the sync writes
  to it. A sync never opens a restricted space again, even if the team becomes public.
- Removing someone from a private team in Linear does **not** revoke their access here. Remove their grant in the space's sharing settings.
- Linear only returns private teams that the API key's own user belongs to. The preview lists any chosen team key
  the key cannot see, because a team it cannot see would otherwise never import.

## Cutover: making StoryOS the master

During a parallel run both tools hold the same issues, and until you say otherwise Linear owns
what it maps: an edit made in StoryOS is replaced by the next sync. **Cutover** is the one switch
that ends that, **per team**. Each team is owned by either **Linear** (the default, exactly what
this page described above) or **StoryOS** (cut over).

**Throwing the switch** (a workspace admin only) does this, in order:

1. Runs one last **full read of that team** from Linear, count-checked against Linear's own
   total like any full read. If that read fails, nothing changes and the team stays with Linear.
2. Records that StoryOS owns the team, when, and who did it.
3. Moves the Issues database's number counter **50 numbers past its highest number** (you can send
   a different `counter_headroom`, 0 to 10,000). StoryOS then numbers new issues after that gap, so an
   issue someone still creates in Linear during the run shows as a gap instead of reusing a number
   StoryOS has handed out.
4. Writes an entry to the **audit log**: who, when, which team.

From then on **no sync writes that team's records**: not the manual Import, not the schedule, not
the incremental run. Nothing is overwritten, no issue Linear created later appears, and an issue
Linear no longer returns is not marked as having left scope. The team is not even read, so it costs no
Linear API budget. Other teams in the same workspace keep syncing as before. **Preview** still reads a
cut-over team and shows `owner: "storyos"` and `sync_writes: false`, so you can see what Linear holds
without anything being written.

**Handing a team back to Linear** is an admin action too, and it asks first: if records were edited in
StoryOS since the cutover, the request is refused with how many, and says the next sync overwrites
them. Send `confirm_overwrite: true` to go ahead. It is logged the same way.

Where it lives: `PUT /workspaces/{ws}/integrations/linear/teams/{team_key}/ownership` with
`{"owner": "storyos"}` or `{"owner": "linear", "confirm_overwrite": true}`. Anyone in the workspace
can read the state with `GET /workspaces/{ws}/linear/ownership` (a team in a space you cannot see is
not listed), and agents can read it with the `get_linear_ownership` tool. **Flipping it is
deliberately not a tool**: handing a team over, or giving it back and overwriting people's edits,
is a decision for a person.

**What it also controls.** GitHub pull-request linking reads the same state: a PR still links to an
issue of a mirrored team, but only moves its status once StoryOS owns the team (while Linear owns it,
the next sync would put the status back).

**What it does not do.**

- It does **not** write status changes to Linear. Comment write-back is unchanged and still optional;
  after a cutover, StoryOS keeps writing nothing else to Linear. Writing status to Linear is not built.
- It does **not** stop people creating issues in Linear, and it does not import comments made in Linear
  after the cutover (nothing inbound is written for that team).
- It does **not** show a banner on the records yet; the state is available to read, and a banner is a
  separate piece of work.
- Slack does not read the state yet.
- It has **not been run against a live Linear workspace**: it is tested with fixtures written from
  Linear's documented API.

## What is intentionally NOT imported

- **Linear's issue history other than state changes.** Edits to titles, priorities, assignees and so on are not
  replayed; the state timeline is. On a plan that keeps no field history, no history is imported and the report says so.

## Limits

- **Everything is paged to the end.** There is no per-team ceiling on issues, cycles, projects or
  comments. On a full read (a manual Import, a Preview, and the first and daily
  scheduled runs) it compares what it read with Linear's own issue count for each team before it
  writes anything, and a mismatch fails with a message naming both numbers, so a short copy never
  lands. All teams are checked before any are written. A scheduled run that reads only changes has no
  total to compare with, so it skips that count check; the daily full read is the one that checks.
- **A status the team's workflow does not list fails the read**, again before anything is written.
- **An issue with more than 50 labels fails the read** rather than losing labels.
- **Milestones are counted by distinct Linear id.** A Linear project can sit on more than one team,
  and a milestone belongs to its project, so the same milestone is written into each of those
  teams' Milestones databases (an issue is linked to the copy in its own team's database). The
  preview and the sync report `milestones.distinct`, the number to compare with Linear's own count;
  the number of records written can be higher. The preview also says how many projects sit on more
  than one team. A project whose milestone list comes back missing fails the read, and a project
  with more milestones than one request holds is read again page by page, so a short list never
  passes for a complete one. Archived milestones are expected to be left out of Linear's list, as
  archived issues are, and so are not imported; that has not been confirmed against a live workspace.
- **Milestone import has not been run against a live Linear workspace yet.** It follows Linear's
  published GraphQL schema (`Project.projectMilestones`, `Issue.projectMilestone`) and is tested
  against fixtures written from that schema.
- **Re-running over an older import** adds your Linear statuses as State options in Linear's order and
  keeps the old ones (*To Do*, *In Review* and so on) after them; it never deletes options.
- Edits to a StoryOS comment after it was written back, and deleting it, are not carried to Linear.
