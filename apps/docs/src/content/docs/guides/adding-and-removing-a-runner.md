---
title: Adding and removing a Runner
description: How a member pairs a computer as a Runner with a 6-character code, turns it on, sends an agent to it and removes it, who can see it, and what offline means.
sidebar:
  order: 13
---

A **Runner** is one computer of yours that runs your agents inside your own Claude Code. This page
covers the life of one: add it, turn it on, send an agent to it, remove it. For what the Runner is
and what it can do, read [The StoryOS Runner](/guides/runner/) first.

:::caution[The Settings screen is coming]
The Settings screen for Runners, with its "Add a Runner" button, is not released yet. The
steps below are what the screen will do, and today they are available as API calls. All of them need
a **signed-in session**: an API token, a connected AI or an agent gets a `403`. That is on purpose,
because a Runner decides where an agent's instructions and your workspace's data go.
:::

## Who can do what

- **Members can add a Runner. Guests cannot.** A guest who tries gets: "Guests cannot pair a Runner.
  Ask a workspace admin if you need access."
- **A Runner is yours.** You see only your own Runners, and only you can turn on, change or remove
  them. Admins included: someone else's Runner id answers exactly as an id that does not exist.
- **An agent runs only on its owner's own Runner.** You cannot send your agent to a colleague's
  computer, because the agent reads records as you and its work passes through that machine.
- **Only an agent whose AI mode is "Your own AI"** can be sent to a Runner.

## Add a Runner

1. **Get a code.** `POST /api/v1/workspaces/{ws}/runners/pairing-codes` returns
   `{ "id", "code", "expires_at" }`. The code has **6 characters** (no `0`, `O`, `1`, `I` or `L`), works
   **once**, and lasts **about 10 minutes**. Asking for a new code cancels your previous unused one,
   and you can ask for 20 codes an hour.
2. **Run the Runner** on the computer that has Claude Code, and type the code:

   ```sh
   npx @storyos/runner
   ```

   Case and dashes do not matter. The Runner lists the tools it found, for example
   `found    Claude Code 2.1.104, signed in`, and the Runner is now **pending**: connected, but doing
   nothing.
3. **Check on it.** `GET /api/v1/workspaces/{ws}/runners/pairing-codes/{id}` answers `waiting`,
   `connected` (with the Runner and the tools it found), `expired` or `cancelled`.
4. **Finish.** `POST /api/v1/workspaces/{ws}/runners/{id}/activate` with `{ "tool": "claude-code" }`
   turns the Runner on. It answers `422` if that tool was not found on the computer, and `409
   pairing_expired` if the window has closed.

If you do not finish within the 10 minutes, or you cancel
(`DELETE /api/v1/workspaces/{ws}/runners/pairing-codes/{id}`), the pending Runner is removed and its
token stops working. Start again with a new code.

The same `npx @storyos/runner` command, run again on a paired computer, just starts the Runner. Pairing a
computer that is already paired replaces its local pairing, and the old Runner stays in StoryOS until
you remove it.

On a **self-managed** server there is nothing to configure in StoryOS. On the computer, point the
Runner at your server with `--server https://your.server`, and give `--mcp-url` for the MCP
service, which is separate from the API.

## Send an agent to it

`PUT /api/v1/workspaces/{ws}/runner-assignments/{agent}` with `{ "runner_id": "<id>" }` sends the
agent to one of its owner's own **active** Runners. Pass `{ "runner_id": null }` to unassign. It
answers `422` unless the agent's AI mode is "Your own AI" and the Runner is active and the owner's
own. An agent with no Runner is not run by anything: its wakes wait, and are cancelled after 7 days.

## See your Runners

`GET /api/v1/workspaces/{ws}/runners` lists your own Runners: status, whether it is connected, the
tools it found, the chosen tool, versions, when it went offline and the agents on each. Removed
Runners are not listed. The MCP tool `list_runners` returns the same, read only.

`PATCH /api/v1/workspaces/{ws}/runners/{id}` with `{ "tool": "..." }` changes which detected tool
your agents use on that Runner.

## Offline

StoryOS marks a Runner **offline** when it has not been heard from for **2 minutes**. A computer
that sleeps or loses its network is offline. Its agents' wakes stay queued and are claimed when it
returns. If agents were assigned to it, you get **one notification per offline episode**.

## Remove a Runner

`DELETE /api/v1/workspaces/{ws}/runners/{id}` removes it. At once:

- its token is refused on its next call, so the Runner on that computer stops and clears its local
  pairing;
- the agents on it are unassigned, so **their wakes wait** until you send them to another Runner;
- wakes it was holding go back to the queue, and the credentials minted for its runs stop working.

Nothing the Runner already wrote is deleted: the audit log still names it. If you no longer want
the computer to try, run `storyos-runner uninstall-autostart` there, and delete `~/.storyos-runner`
if you want its files gone.

A Runner is also removed when its owner leaves the workspace.
