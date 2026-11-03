---
title: The StoryOS Runner
description: Run the agents you hire in StoryOS on your own computer, inside your own Claude Code subscription. What it is, how to install and pair it, what wakes an agent, its limits, its security model and what to check when it does not work.
sidebar:
  order: 12
---

The **Runner** is a small program that runs the agents you hire in StoryOS **on your own
computer, inside your own Claude Code**, on your own subscription. StoryOS decides when an agent
should look at a record. The Runner wakes Claude Code, gives it that one job, and tells StoryOS how
it went.

It is open source (Apache-2.0) and it only ever makes **outbound** connections. It opens no port,
so it works behind a home router or a company proxy.

:::caution[Status, as of 3 November 2026]
- **Claude Code works.** Cursor is **coming** and is not usable yet: a Runner whose chosen tool is
  Cursor claims nothing, and its agents' wakes wait in StoryOS.
- **Budgets, token cost, and sharing limits (working hours, a reserve for yourself) are coming.**
  Nothing on this page describes them as working.
- **The Settings screen for Runners is coming.** Today, pairing, turning on and removing a Runner
  exist as API calls that need a signed-in session. See
  [Adding and removing a Runner](/guides/adding-and-removing-a-runner/).
- **The `@storyos/runner` package was not yet on the npm registry** when this was written, so
  `npx @storyos/runner` cannot find it until it is published.
:::

## Before you start

- **Node 22 or newer** on the computer that will run the Runner.
- **Claude Code**, installed and signed in on that computer. Run `claude` once, then check that a
  real call works:

  ```sh
  claude -p "say hi"
  ```

  `claude auth status` alone can say you are signed in when the sign-in has expired, so do not rely
  on it.
- A StoryOS workspace where you are a member. **Guests cannot pair a Runner.**
- An agent whose **AI mode is "Your own AI"**. Only those agents are served by a Runner.

## Install and pair

1. Get a **6-character code** from StoryOS (see
   [Adding and removing a Runner](/guides/adding-and-removing-a-runner/)).
2. On the computer that has Claude Code, run:

   ```sh
   npx @storyos/runner
   ```

3. Type the code. The Runner lists the tools it found on this computer (for example
   `found    Claude Code 2.1.104, signed in`), then waits.
4. Turn the Runner on in StoryOS and choose Claude Code. Until you do, the Runner does nothing.

If the computer is already paired, the same command simply starts the Runner. For a self-managed
StoryOS server, add `--server https://your.server` (or set `STORYOS_URL`).

The code works **once** and lasts **about 10 minutes**. If you do not finish within that window, or
you cancel, the pending Runner is removed and you start again with a new code.

### Commands

| Command | What it does |
|---|---|
| `storyos-runner pair [code]` | Pair this computer with the code from StoryOS. |
| `storyos-runner start` | Run in the foreground and wait for work. |
| `storyos-runner status` | Show what this computer knows, then check the server. `--offline` skips the server check. |
| `storyos-runner stop` | Ask the running Runner to stop. |
| `storyos-runner install-autostart` / `uninstall-autostart` | Start it at login. See [Keeping it running](#keeping-it-running). |

| Option | Meaning |
|---|---|
| `--server <url>` | The StoryOS server (default `https://app.storyos.dev`, or `STORYOS_URL`). |
| `--concurrency <n>` | How many wakes run at once on this computer. Default 1. |
| `--run-timeout <minutes>` | Stop one run after this long. Default 30. |
| `--mcp-url <url>` | Where Claude Code reaches StoryOS's MCP server. Needed on a self-managed server, because the MCP server is its own service and not `<server>/mcp`. |
| `--adapter stub` | A dry run that claims and reports wakes but does no real work. Use it to check an install. |

## What wakes an agent

A **wake** is a queued request that says "this agent should look at this record now, and here is
why". It carries ids and a reason, never the text of a comment or field. The reasons are:

- the record entered a **state** an agent is bound to;
- the record was **linked** to the agent through a relation an agent is bound to ("assigned");
- the agent was **@-mentioned in a comment**;
- an **automation** ran its "run agent" action (this includes schedules);
- someone **ran or delegated** to the agent by hand;
- an **approval** the agent was waiting on was decided;
- the agent finished without commenting on its record and is woken **once more** to do so.

Repeats coalesce: several comments in a minute become one wake that sees all of them, and an agent
works on one record at a time. A chain of agents waking agents stops at depth 2.

While a wake waits, StoryOS reports why: waiting for a Runner, the Runner being offline, the
subscription limit, or waiting its turn. For how a run, its steps and its comment appear, see
[Agent runs](/concepts/agent-runs/).

A wake nobody serves is cancelled after **7 days**.

## What the agent can do

The agent runs as the person who owns it and gets **only StoryOS tools**, connected with a
short-lived credential made for that one run. There is no MCP setup to do.

- No shell, no file access and no web by default. Your own Claude settings (hooks, allow-lists) do
  not apply to the session.
- The credential's reach is the lower of the owner's role and the agent's declared scopes, and is
  never admin.
- A run ends with a **comment on the record**. If it does not comment, it is woken once more, then
  fails visibly and its owner is told.
- `ANTHROPIC_API_KEY` is not passed to the session, so it uses your subscription.

## Limits

- **One run is stopped after 30 minutes** (change it with `--run-timeout`).
- **Subscription limit.** If Claude Code reports that your limit is reached, the wake waits in
  StoryOS until the reset time it reported. If it gives none, the wake retries after an hour; a
  reported time further away than 7 days is cut to 7 days.
- **Concurrency is 1** by default, so a Runner does one wake at a time.
- **A laptop that sleeps is offline**, and its agents wait. See below.

## Offline, and keeping it running

StoryOS marks a Runner **offline** when it has not been heard from for **2 minutes**. Queued wakes
stay queued and are claimed when it returns. The owner is notified once per offline episode, when
agents are assigned to that Runner.

If a Runner stops mid-run, or loses the network for longer than its **90-second lease**, the wake is
**abandoned, not reported**: StoryOS puts it back in the queue (and fails it after 3 lost leases).
Delivery is at-least-once, so an agent can see the same wake twice. A comment on the record is its
memory of what it already did.

### Keeping it running

Autostart needs a permanent install, not the `npx` cache:

```sh
npm install -g @storyos/runner
storyos-runner install-autostart
```

- **macOS** writes a launch agent (`~/Library/LaunchAgents/dev.storyos.runner.plist`): start at
  login, restart after a crash, stay stopped after `stop`.
- **Linux** writes a systemd **user** unit (`~/.config/systemd/user/storyos-runner.service`) and
  enables it. To keep it running after you log out, run `loginctl enable-linger $USER`.
- **Windows:** no autostart is built in, and Windows was not tested for this page.
- `install-autostart --print` shows the file without writing it; `--no-load` writes it without
  loading it. The file carries your `PATH` and **no secret**.

To run it on an always-on server so agents work overnight, see
[Running the Runner on a small Linux server](/guides/runner-on-a-server/).

## Security

**What is on your computer.** Everything is under `~/.storyos-runner` (or `STORYOS_RUNNER_HOME`),
readable by you only:

| Path | What |
|---|---|
| `config.json` | the server, and the **runner token** |
| `state.json` | the wakes this computer holds now, so a restart never runs one twice |
| `logs/runner.log` | the log, rotated at 1 MB, five files kept |
| `agents/<workspace id>/<agent id>/` | each agent's own working folder |

- **The runner token is a plain file (`0600`), not in the OS keychain.** Anyone who can read your
  home directory can read it, as they could your SSH keys. Removing the Runner in StoryOS stops the
  token working at once.
- **The runner token cannot read your data.** It can claim wakes for the agents assigned to that
  Runner, send a heartbeat and report a result. It is refused everywhere else in StoryOS.
- **Secrets are masked.** The runner token, the pairing code and each run's credential are masked in
  the log and on the terminal. The run credential lives in memory for the run.
- **Record text is data.** The wake carries no text. The agent reads the record through StoryOS, and
  its instructions say that what it reads is data, not orders.
- **One folder per agent.** A session starts in that agent's folder and is given no other
  directory. The Runner rewrites `INSTRUCTIONS.md` there at the start of each wake and empties
  `scratch/` afterwards.
- **Only a signed-in person can pair, turn on, change, remove or assign a Runner**, never an API
  token, a connected AI or an agent.
- **Approvals still apply.** Agent actions that a manager gated wait for a person's decision. See
  [Approval gates](/concepts/approval-gates/).

:::danger[A known gap in outward actions]
A record an agent edits can fire an action an admin configured on it (an email, a webhook, a Slack
message) **without an approval**. This is tracked and not yet decided. Until it is, only run agents
in workspaces whose rules you know.
:::

:::note[Known risk: one undocumented Claude Code setting]
The Claude Code adapter sets `MCP_CONNECTION_NONBLOCKING=0` for the session. It is undocumented and
was verified on Claude Code **2.1.104** only. If a Claude Code release breaks it, the agent has no
StoryOS tools and does no work: the run ends without a comment, is re-run once, then fails visibly
and tells the owner. In the Runner log, `mcp storyos=pending` means this is what happened.
:::

## Troubleshooting

Run `storyos-runner status` first. It prints whether this computer is paired, whether the Runner is
running, how many wakes are in flight, the log path and whether the server is reachable.

| You see | What it means, and what to do |
|---|---|
| `That code is not valid.` | The code was mistyped or replaced. A new code replaces your previous unused one. Get a fresh one. |
| `That code was already used.` | A code works once. Get a new one. |
| `The pairing window ended before you pressed Done` | More than 10 minutes passed. Run `npx @storyos/runner` again with a new code. |
| `This Runner is too old for this StoryOS server` | Update with `npx @storyos/runner@latest`. |
| `This computer is not paired yet.` | Pair first: `npx @storyos/runner`. |
| `The Runner is already running on this computer` | Only one runs per computer. Run `storyos-runner stop`, or leave it. |
| `This Runner was removed in StoryOS.` | It was removed. The local pairing is cleared; pair again. If autostart is installed, run `storyos-runner uninstall-autostart` first, or it keeps restarting and failing. |
| `NOT signed in: open it once and sign in` | Claude Code is installed but not signed in. Run `claude`, sign in, and test with `claude -p "say hi"`. |
| The log says there is no adapter for the tool you chose | You chose Cursor. It is not supported yet; choose Claude Code. |
| A run ends with no comment and the log shows `mcp storyos=pending` | The undocumented setting above. Check your Claude Code version. |
| Wakes wait while the laptop is closed | A sleeping computer is offline. Use an always-on machine. |
