---
title: Connecting GitHub
description: Importing a GitHub repository's issues and pull requests into StoryOS, how a pull request gets linked to a record, choosing which repositories are watched, and what the "Not tracked, but sending events" list means.
sidebar:
  order: 10
---

The GitHub integration imports **issues and pull requests** into a GitHub space and keeps them
fresh on every sync. A pull request is linked automatically to the record it names; the
rules are in [Branch names and pull request linking](#branch-names-and-pull-request-linking). A bare
`#number` never links.

It lives at **Settings → Integrations → GitHub**. This page covers connecting, choosing repositories
and the one list that tends to puzzle people. The page also has a **Code and reviews** section, which
isn't covered here.

## Connecting

The page walks you through three steps: **Connect GitHub**, **Choose repositories**, then **Sync and
inspect** (run the first sync and open the generated GitHub space). There are two ways to connect:

- **The GitHub App.** Connect an installation. StoryOS then posts a backlink comment on linked pull
  requests and lets you pick which repositories it watches, with no personal token.
- **A personal access token.** Paste a token (read access to the repositories) and list the
  repositories, one `owner/name` per line.

Once GitHub is connected, the page leads with the connection card. The steps, App box and token form
move under a closed **Change how GitHub is connected** line (**Setup steps, keys and tokens**); open
it to change the connection. Until GitHub is connected, those steps are the page and stay open.

## Branch names and pull request linking

**Get a branch name.** Every record in a database with record numbers has a branch name, worked out
from its number and title each time you ask. Nothing is stored, so it follows a title change. The
shape is `<number>-<title-slug>`, or `<lane>/<number>-<title-slug>` when you pass a lane. The lane is
one of `docs`, `mcp`, `api`, `web` or `fix`. The slug is the title lowercased, with accents removed
and every run of other characters turned into one hyphen, cut to at most 48 characters (at a word
boundary when there is one past the midpoint). For example, `api/1219-git-branch-names`.

- **API:** `GET /api/v1/…/records/:rec/branch-name?lane=api` returns `record_id`, `number` and
  `branch_name`. An unknown lane is a 400, and a database without record numbers is a 400. You need
  at least viewer access to the record.
- **MCP:** the `get_branch_name` tool takes the workspace, database, record and an optional lane. It is a
  maintainer tool, so it is only offered on the internal profile (`?profile=internal`), not on a customer's
  connection; everyone else uses the API route above.

**How a pull request links.** When a `pull_request` delivery arrives, StoryOS looks for a record in this
order and links the first one that exists:

1. The branch `story-<N>`, a record number in the repository's link database.
2. A link to a StoryOS record in the title or description. The link names its own database, so it works
   from any repository.
3. A record **identifier** (see below), in the branch, then the title, then the description.
4. The branch, if it starts with a lane and a number: `docs/`, `mcp/`, `api/`, `web/` or `fix/`
   followed by digits, then a hyphen or the end (`web/1234-fix-title` or `web/1234`).
5. The words **`ticket #N`** or **`issue #N`** (plural and any capitals accepted) in the pull request
   title, then its description. Only the number counts, never the slug.

**Linking by identifier.** A database can carry an identifier prefix (for example `ISSUE`), so its
records answer to `ISSUE-5201`. A pull request links to that record when the identifier appears as:

- a branch such as `feat/issue-5201`, `bugfix/issue-5201`, `fix/issue-5201` or `release/issue-5201`, or
  `issue-5201-short-title` or `dana/issue-5201-short-title`, in any capitals (the part after the last
  slash may carry a short title after the number);
- `ISSUE-5201` in the pull request title or description, in capitals. A lower-case `issue-5` in a
  sentence is just words and does not link.

The identifier is read as the database's prefix plus the record's number, never as an internal id, so the
pull request moves the record with that identifier. Only the prefix of the repository's own link database
counts. An identifier from another database in the workspace, or text that merely looks like one (such
as `CVE-2024-1234`), links nothing, and a prefix belongs to one database in a workspace, so one identifier
never names two. A link database with no identifier prefix cannot be reached this way. When a pull request
names several identifiers of the link database, the branch wins, then the title, then the description.

**A link database for each repository.** Record numbers and prefixes belong to one database, so each
repository says which database its pull requests link into. On the GitHub integration page, **Link
database per repository** lists every repository you watch with a menu of databases. This is what lets
two repositories each have their own tickets: a `story-3` branch on one repository can never move a
record in the other repository's database.

- A connection set up before this existed has one workspace-wide link database, which still applies to
  every repository. The first time you choose a database for a repository, StoryOS copies the
  workspace-wide one onto each repository you watch and then only the per-repository choices count.
  Select the repositories to watch first: with none selected, there is nothing to copy it onto and the
  change is refused.
- Once a connection is per repository, a repository with no database of its own links nothing by branch
  number or identifier. Choose **No link database** to take a repository's choice away. A link to a
  StoryOS record in the description still works.
- **API:** `POST /api/v1/workspaces/:ws/integrations/github` takes `link_databases`, a map from
  `owner/name` to a database id (or `null` to remove it); `GET` returns it, or `null` while the old
  workspace-wide `link_database_id` is still in force. Every id must be a database of this workspace
  (otherwise a 422), and once the connection is per repository `link_database_id` is refused. Only
  admins can read or change it. There is no MCP tool for it, as for the rest of the integration
  settings.

A bare `#N` never links, even when N is a real record, because pull request numbers and record
numbers share the same range. A number with no matching record is ignored without an error, and a
redelivery of the same pull request does not create a second one. A pull request that links also gets
the one backlink comment and the state moves you set for opened, merged and the other events, whichever
rule found the record.

**What it needs.** The webhook must send **pull requests** events, and each repository must have a link
database. Numbers and prefixes belong to one database, so branch, identifier and `ticket #N` matches
resolve only against that repository's database; with none they do not link, and only a record URL in the
description does.

## Choosing repositories

Once you have selected at least one repository, StoryOS ignores incoming GitHub events from every
other repository, and the notice below reports what it skipped. **With no repository selected, events
from every repository are accepted and no notice appears**, so select the ones you want to narrow
it.

## "Not tracked, but sending events"

If this box appears, GitHub is sending StoryOS events for repositories you haven't selected, and
StoryOS is **deliberately skipping them**. It answers GitHub with a success and imports nothing.
Without the box that looks exactly like a healthy, quiet connection, so it says so instead.

- The header shows how many repositories are listed. Each row names a repository, how many events
  arrived, and the type and time of the latest one (for example "3 events · last push"). Older rows
  recorded before the type was kept show the time only.
- **Track** on a row adds that repository to your selection, with the same call the repository picker
  uses, and the row goes away. A "Tracking {repository}" message confirms it.
- The box shows the first three repositories; **and N more** with **Show all** opens the rest. A line
  below counts events from repositories StoryOS does not list by name, which have no row to track.
- Saving other settings keeps the tally, and disconnecting clears it.
- It appears for both the GitHub App and the personal-token connection, and only to people who can
  open the integration page, which is limited to admins.
