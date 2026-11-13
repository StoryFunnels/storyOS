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

:::caution[Status, as of 10 November 2026]
- **The Runner drives Claude Code.** It is the only tool that runs agents today. A Runner set to
  any other tool claims nothing, and its agents' wakes wait in StoryOS.
- **Agent budgets have no screen yet.** You set them as two fields on the agent's record, and they
  work (see [Budgets](#budgets)). The web app does not yet show a budget or a budget pause by name.
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

1. Get a **6-character code** from StoryOS: in the web app, **Settings → Runners → Add a Runner**
   (see [Adding and removing a Runner](/guides/adding-and-removing-a-runner/)).
2. On the computer that has Claude Code, run:

   ```sh
   npx @storyos/runner
   ```

3. Type the code. The Runner lists the tools it found on this computer (for example
   `found    Claude Code 2.1.104, signed in`), then waits.
4. Back in StoryOS, choose the tool and press **Done**. That turns the Runner on. Until you do, the
   Runner is connected but does nothing.

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

### Schedules

A schedule is a rule whose trigger is a time, with a **Run an agent** action. You can set one in the
hire dialog (**Wakes when**), or through the API or the `create_automation` tool.

A schedule trigger takes:

| Setting | Meaning |
|---|---|
| `every` | `minutes`, `hour`, `day` or `week`. |
| `minutes` | With `every: "minutes"`: a whole number from **10** to **1440**. Below 10 is refused with a `422` that says so; it is not rounded up. |
| `at` | The time of day (`HH:MM`) for `day` and `week`. |
| `weekday` | One day for `week`: 0 is Sunday, 1 is Monday. |
| `weekdays` | A list of days the rule may fire on, for `minutes`, `hour` and `day`: Monday to Friday is `[1,2,3,4,5]`. Not for `week`. |
| `between` | An active window, `{ "from": "09:00", "to": "18:00" }`, for `minutes` and `hour` only. `to` is not included. If `from` is later than `to` the window runs past midnight, and it belongs to the day it starts on. |
| `timezone` | An IANA zone such as `Europe/Madrid`, in which the times, the window and the days are read. Leave it out and the server's own zone is used. |

- **Slots count from the start of the window.** With `minutes: 30` and no window, slots fall on
  :00 and :30 from midnight. With a window of 09:00 to 18:00, the first slot is 09:00. Slots are
  counted in elapsed time, so a daylight-saving change does not add or remove one.
- **The rule says which zone it used.** A rule's response carries `schedule.timezone` and
  `schedule.timezone_source` (`rule` or `server_default`), and `schedule.runs_per_day` (an estimate
  for a typical qualifying day; empty for a weekly rule). The hire dialog uses it for "About N runs a
  day".
- **Missed slots become one firing.** If the StoryOS scheduler was not running for several slots,
  the rule fires **once** when it is back, not once per missed slot. If a rule with a window comes
  back outside its window, it does not fire for what it missed.
- **A rule saved before these settings existed** and without any of them keeps the behaviour it had:
  hour, day or week, read in the server's zone.

**A scheduled firing wakes a Your-own-AI agent once, with no record.** However many records the
rule selects, the agent gets **one** wake for that firing and reads what it needs itself. Two
scheduler ticks, or a retry, for the same firing do not add a second wake. The next firing is a new
wake, or it joins one that is still waiting. This is different from a rule that fires on a record
(a state change, a new record), where an agent is still woken once for each record. An agent that
runs on StoryOS's own AI is still run once per record by a scheduled rule.

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

### Where an agent works: databases and whole spaces

An agent's record in the Agents database has two text fields that say where it works:

- **Target databases**: database names, one per entry.
- **Target spaces**: space names or ids. A space stands for every database in it.

Entries are separated by commas or new lines; names are matched ignoring case. A space target is
**resolved each time it is used**, not copied when the agent is hired, so a database created in that
space later is in the agent's scope on its next call. A personal space is never included, and neither
is a database the agent's manager cannot open: the agent's credential is never wider than its manager.
An entry that matches nothing, or matches a personal space, is reported as `unresolved` rather than
dropped silently.

- **`enforced`.** An agent with at least one target space has its scope enforced on its credential: it
  works in the databases of those spaces plus any it names. An agent with only target databases keeps
  the behaviour it always had: its Target databases text is its brief, not a boundary.
- **Who sets it.** A person edits these fields. An agent that tries to change an agent's Target spaces is
  refused with a 403, like its Tools, Model and budget. The hire card's **Works in** picker lists
  databases only (see [Hiring an agent](/guides/hiring-an-agent/)), so to target a space, edit the
  **Target spaces** field on the agent's record.
- **Reading the resolved scope.** `GET /workspaces/{ws}/agents/{agent}/scope` (the agent's uuid or public
  number) returns `agent_id`, `enforced`, `spaces` (`id`, `name`), `databases` (`id`, `name`, `space_id`,
  `via`: `database` or `space`), `unresolved`, and `withheld_count`, the number of databases left out
  because the manager cannot open them. Over MCP this is `get_agent_scope`. **Workspace admins only**:
  anyone else gets a 403.
- **Reading what wakes it.** `GET /workspaces/{ws}/agents/{agent}/wake-sources` returns `sources`: the agent's
  triggers (`kind: agent_trigger`, a state or a relation `binding`, `enabled`, `human_gate`) and every automation
  rule with a Run agent action for it (`kind: automation`, `name`, `enabled`, its `database` and `trigger`: record
  created, field change, link, or schedule). Something deleted comes back with a `null` name, and `withheld_count`
  is how many sources sit on databases the caller cannot open. Over MCP this is `get_agent_wake_sources`. Readable
  by the agent's manager and by workspace admins; anyone else gets the same 404 as for an unknown agent.
- **On the Runner claim.** When a Runner claims a wake, the agent block carries `scope` with `enforced`,
  `spaces`, `databases` and `unresolved`, resolved at that claim and narrowed to what the manager can open.

### Which tools it is offered, and what that costs

A Runner run is **offered a short list of StoryOS tools**, not all of them. With nothing saved on the
agent, the list is eight: `get_record`, `list_comments`, `query_records`, `count_records`,
`describe_database`, `update_record`, `add_comment` and `create_record`.

The reason is cost on your subscription. Every tool offered is described to the model on every
request of every run, whether or not it is used. On one test wake, offering every tool a write-level
credential allows took about 97,000 input tokens a run, against about 12,000 for the eight. Those are
figures from one measured wake, not a promise for your agents.

- On the agent's page, **Advanced → Tools** lists the eight and lets a manager add **extras** the
  agent's role allows. Choosing **all** offers every tool the role allows, and the page says that
  makes each run much bigger on your limit.
- **This limits what is offered, not what is allowed.** The run's credential, set by the owner's
  role and the agent's scopes, still decides what a call may do.
- This applies to Runner runs. An AI you connect to StoryOS yourself is offered the full set, as before.

### Skills

If the agent has skills attached, a Runner run is given **each skill's instructions** in its own
instructions, not just the names, as in a run inside StoryOS. See
[Skills on a Runner](/concepts/skills/#on-a-runner-the-skills-instructions-are-sent).

## Sharing your subscription

The Runner uses your own subscription, so you decide when and how much of it your agents may use.
Each Runner has two rules, set on **Settings → Runners**, in the **Sharing your subscription**
section of that Runner's row. Only the person who owns the Runner can change them. Each saves as soon
as you change it, and through the API they are `working_hours` and `reserve_percent` on
`PATCH /api/v1/workspaces/{ws}/runners/{id}`.

**Working hours.** Choose the days, a start and an end time, in a time zone (the screen proposes your
computer's zone).

- **Outside the window the Runner claims nothing.** A queued run shows **Outside working hours,
  resumes** and the time.
- **A run already going finishes.** Working hours decide when a run may start, not when it must stop.
- **A window can run past midnight.** If the end is not after the start (22:00 to 06:00), the window
  belongs to the day it starts on: a Monday 22:00 window is still open at 02:00 on Tuesday.
- **It follows the wall clock.** The times are in the zone you chose, so a daylight-saving change
  does not move them by an hour.
- Working hours off means every hour.

**Keep a share for me ("leave me X%").** You can store a share from 1% to 95% of your limit to keep
back. It is **kept only where the tool reports how much of your plan is used**.

- **Claude Code does not report that today.** The version checked here, 2.1.104, reports tokens per
  run and nothing about your plan. For a Runner using it, the screen shows **Cannot be measured for
  this tool**, disables the control, and marks a stored value **not kept**. It is not a protection,
  and the page does not present it as one.
- Where a tool does report it, the Runner stops claiming when your remaining share falls below the
  one you set, and the run shows **Keeping your reserve**.

**When the tool hits your subscription limit,** that Runner pauses all its claims until the reset
time the tool gave, then resumes by itself. Your other Runners are not affected by that pause. See
[Limits](#limits).

On a Runner row, the status line says which of these applies: **Waiting for your Claude limit to
reset**, **Outside working hours** or **Keeping your reserve**, each with the time it is expected
to end when known.

## Budgets

An agent can have a **monthly budget** in tokens, in runs, or both. A budget is two number fields
on the agent's record: **Monthly token budget** and **Monthly run cap**. Empty means no limit, and a
number must be a whole number from 1. Only a person can set one: an agent cannot change its own.

- **The month is a UTC calendar month**, the same for everyone in the workspace.
- **At 80%** the agent's manager (its creator, or the workspace admins if the creator has left) gets
  one notice.
- **At 100%** the agent is not given new work. Its queued runs wait and read **waiting for its
  budget**. It resumes when you raise or clear the budget, or on the 1st of the next month (UTC).
- **One notice per threshold, per limit, per month.** Raising a limit lets its notices fire again.
- **A pause stops new runs only.** A run already going finishes and its tokens count, so usage can
  end above 100%.
- **What the token total counts:** the tokens the runs reported, plus the tokens of AI fields that
  recomputed because of this agent's write. Only usage the tool or vendor **reported** is counted.
  When none was reported the usage is "not measured", never 0, and a total that leaves some out is
  "at least". For a tool that reports no tokens, only the run cap can pause the agent.
- **A run is counted when a Runner starts it.** A queued run has used nothing.
- A wake that waits more than 7 days is cancelled as usual, budget or not.

The numbers are readable at `GET /api/v1/workspaces/{ws}/agents/{agent}/budget` and with the
`get_agent_budget` tool. `get_agent_wake_summary` carries a `budget` for each agent, and a run
paused by a budget has the `run_state` `waiting_for_budget`. The notices are
`agent_budget_warning` and `agent_budget_paused`.

:::note[What is not built]
There is no budget screen yet: you set the two fields on the agent record, and the web app's run list
does not yet name a budget pause. AI-field calls made before agents were recorded as the cause of
them are not counted. A money budget for agents that use an API key does not exist.
:::

## Limits

- **One run is stopped after 30 minutes** (change it with `--run-timeout`).
- **Subscription limit.** If Claude Code reports that your limit is reached, the wake waits in
  StoryOS until the reset time it reported. If it gives none, the wake retries after an hour; a
  reported time further away than 7 days is cut to 7 days.
- **Working hours and a budget** can also hold a run back. See
  [Sharing your subscription](#sharing-your-subscription) and [Budgets](#budgets).
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
| The log says there is no adapter for the tool you chose | Only Claude Code can run agents today; choose Claude Code. |
| A run ends with no comment and the log shows `mcp storyos=pending` | The undocumented setting above. Check your Claude Code version. |
| Wakes wait while the laptop is closed | A sleeping computer is offline. Use an always-on machine. |
| A run says **Outside working hours** | The Runner's working hours are closed. It resumes at the time shown, or switch working hours off in **Sharing your subscription**. |
| A run says **Keeping your reserve** | Only on a tool that reports plan usage: your remaining share is below the one you set. |
| An agent's runs wait and the run state is `waiting_for_budget` | It used its monthly budget. Raise or clear the budget on the agent's record, or wait for the 1st (UTC). |
| A run fails and names a skill | A skill attached to the agent was removed, renamed, cannot be read by the agent's owner, or is a personal skill that may not go to this Runner. See [Skills on a Runner](/concepts/skills/#on-a-runner-the-skills-instructions-are-sent). |
