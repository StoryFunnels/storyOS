---
title: Connecting GitHub
description: Importing a GitHub repository's issues and pull requests into StoryOS, choosing which repositories are watched, and what the "ignoring deliveries" notice means.
sidebar:
  order: 10
---

The GitHub integration imports **issues and pull requests** into a GitHub space and keeps them
fresh on every sync. A pull request is linked automatically to an issue it references by
`#number` in its title or branch name.

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
