---
title: Connecting GitHub
description: Importing a GitHub repository's issues and pull requests into StoryOS, how a pull request gets linked to a record, choosing which repositories are watched, and what the "ignoring deliveries" notice means.
sidebar:
  order: 10
---

The GitHub integration imports **issues and pull requests** into a GitHub space and keeps them
fresh on every sync. A pull request is linked automatically to the record it names; the
rules are in [Branch names and pull request linking](#branch-names-and-pull-request-linking). A bare
`#number` never links.

It lives at **Settings → Integrations → GitHub**. This page covers connecting, choosing repositories
and the one notice that tends to puzzle people. The page also has a **Code & reviews** section, which
isn't covered here.

## Connecting

The page walks you through three steps: **Connect GitHub**, **Choose repositories**, then **Sync and
inspect** (run the first sync and open the generated GitHub space). There are two ways to connect:

- **The GitHub App.** Connect an installation. StoryOS then posts a backlink comment on linked pull
  requests and lets you pick which repositories it watches, with no personal token.
- **A personal access token.** Paste a token (read access to the repositories) and list the
  repositories, one `owner/name` per line.

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
- **MCP:** the `get_branch_name` tool takes the workspace, database, record and an optional lane.

**How a pull request links.** When a `pull_request` delivery arrives, StoryOS looks for a record
number in this order and links the first one that exists:

1. The branch, if it starts with a lane and a number: `docs/`, `mcp/`, `api/`, `web/` or `fix/`
   followed by digits, then a hyphen or the end (`web/1234-fix-title` or `web/1234`).
2. The words **`ticket #N`** or **`issue #N`** (plural and any capitals accepted) in the pull request
   title, then its description. Only the number counts, never the slug.

A bare `#N` never links, even when N is a real record, because pull request numbers and record
numbers share the same range. A number with no matching record is ignored without an error, and a
redelivery of the same pull request does not create a second one. The older `story-<N>` branch form
and a link to a StoryOS record in the description still work.

**What it needs.** The webhook must send **pull requests** events, and the integration must have a
link database configured. Numbers belong to one database, so branch and `ticket #N` matches resolve
only against that database; with none configured they do not link, and only a record URL in the
description does.

## Choosing repositories

Once you have selected at least one repository, StoryOS ignores incoming GitHub events from every
other repository, and the notice below reports what it skipped. **With no repository selected, events
from every repository are accepted and no notice appears**, so select the ones you want to narrow
it.

## "Ignoring deliveries from repositories you have not selected"

If that notice appears, GitHub is sending StoryOS events for repositories you haven't selected, and
StoryOS is **deliberately skipping them**. It answers GitHub with a success and imports nothing.
Without the notice that looks exactly like a healthy, quiet connection, so it says so instead.

- It lists each repository with how many deliveries were skipped and when the last one arrived.
  After 50 different repositories, further ones are only counted as *"…and N more from other
  repositories"*.
- **Selecting a repository removes it from the list.**
- Saving other settings keeps the tally, and disconnecting clears it.
- It appears for both the GitHub App and the personal-token connection, and only to people who can
  open the integration page, which is limited to admins.

If you never intended to watch that repository, nothing is wrong: the notice is information, and
the skipped events are simply not imported.
