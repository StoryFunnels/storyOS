---
title: Adding and removing a Runner
description: How a member pairs a computer as a Runner from Settings with a 6-character code, turns it on, sends an agent to it and removes it, who can see it, and what offline means.
sidebar:
  order: 13
---

A **Runner** is one computer of yours that runs your agents inside your own Claude Code. This page
covers the life of one: add it, turn it on, send an agent to it, remove it. For what the Runner is
and what it can do, read [The StoryOS Runner](/guides/runner/) first.

:::note[On the screen, and through the API]
Everything below is on **Settings → Runners** (in the AI group of Settings). Each step also has an API
call, listed with it. All of them need a **signed-in session**: an API token, a connected AI or an
agent gets a `403`. That is on purpose, because a Runner decides where an agent's instructions and
your workspace's data go.
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

On the screen, press **Add a Runner** (or **Add a Runner…** in an agent's **Runs on** menu, or on the
hire card). It shows three steps: run `npx @storyos/runner` in Terminal on the computer where Claude
Code is signed in; type the 6-character code when it asks; then, when the card says the computer is
connected, choose the tool it found and press **Done**. The card says that until you press Done the
computer is connected but does nothing. If the Runner found none of the tools, the card says so and
you add the Runner again after signing in on that computer. If the code runs out, the card says
"That code ran out. Codes work once, for ten minutes." and you start again.

Through the API, the same steps:

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

On the screen, an agent that uses **Your own AI** shows **Runs on <computer> · <tool>** on its page,
with a **Change** menu listing your Runners and their live status, and **Add a Runner…**. Only the
agent's owner sees **Change**: for anyone else the line is read-only, and a guest is told only "Runs
on a Runner". You can hire an agent before you have a Runner: the hire card says "You can hire it now.
It starts work once it has a Runner."

Through the API, `PUT /api/v1/workspaces/{ws}/runner-assignments/{agent}` with `{ "runner_id": "<id>" }` sends the
agent to one of its owner's own **active** Runners. Pass `{ "runner_id": null }` to unassign. It
answers `422` unless the agent's AI mode is "Your own AI" and the Runner is active and the owner's
own. An agent with no Runner is not run by anything: its wakes wait, and are cancelled after 7 days.

## See your Runners

**Settings → Runners** lists your own Runners, one row each: its name, the tool, when it was paired,
the agents it runs, and a live status line. The status reads, for example, **Online · checked a
minute ago**, **Offline since 18:40 · agents wait until it's back**, **Waiting for your Claude limit
to reset at 18:40**, **Outside working hours** or **Keeping your reserve**. A Runner whose tool was
not found, or that needs updating, says so. Each row also has **Sharing your subscription**, for
working hours and a reserve for yourself: see [Sharing your subscription](/guides/runner/#sharing-your-subscription).

An agent's page has a **Runs** list. Each row names the record and says what stage the run is at:
**Waiting for a Runner**, **Waiting to start on <computer>**, **Waiting for the Runner** (it does one
job at a time), **Runner offline since <time> · starts when it's back**, **Waiting for your Claude
limit to reset at <time>**, **Outside working hours**, **Keeping your reserve**, **Running on
<computer>**, **Needs your approval** (with a **Review** link), **Done**, **Failed** or **Canceled**.
These come from the `run_state` the API reports for each wake; see
[Agent runs](/concepts/agent-runs/#where-a-wake-stands).

Through the API, `GET /api/v1/workspaces/{ws}/runners` lists your own Runners: status, whether it is connected, the
tools it found, the chosen tool, versions, when it went offline and the agents on each. Removed
Runners are not listed. The MCP tool `list_runners` returns the same, read only.

`PATCH /api/v1/workspaces/{ws}/runners/{id}` with `{ "tool": "..." }` changes which detected tool
your agents use on that Runner. The same call takes `working_hours` and `reserve_percent`.

Only Claude Code can run agents today. A Runner whose chosen tool is Cursor claims nothing, and its
agents' wakes wait.

## Offline

StoryOS marks a Runner **offline** when it has not been heard from for **2 minutes**. A computer
that sleeps or loses its network is offline. Its agents' wakes stay queued and are claimed when it
returns. If agents were assigned to it, you get **one notification per offline episode**.

## Remove a Runner

On the screen, press **Remove…** on the Runner's row. It asks for confirmation, naming the agents
that would wait ("... until you add another Runner. Nothing is deleted."), and confirming removes it.

Through the API, `DELETE /api/v1/workspaces/{ws}/runners/{id}` removes it. At once:

- its token is refused on its next call, so the Runner on that computer stops and clears its local
  pairing;
- the agents on it are unassigned, so **their wakes wait** until you send them to another Runner;
- wakes it was holding go back to the queue, and the credentials minted for its runs stop working.

Nothing the Runner already wrote is deleted: the audit log still names it. If you no longer want
the computer to try, run `storyos-runner uninstall-autostart` there, and delete `~/.storyos-runner`
if you want its files gone.

A Runner is also removed when its owner leaves the workspace.
