# Starting the agents

**Each agent is a Claude Code session you open, not a background job.**

## Why not launchd / cron / the CLI

Tried, and it cannot work here:

- **OAuth cannot be shared with a spawned CLI.** `claude -p` fails with
  `OAuth session expired and could not be refreshed`, even on the same version
  running your live session. The desktop app holds the auth; a child process
  does not inherit it.
- **An API key is not an option** — these run on Ievgen's Claude account, by
  decision. Never add `ANTHROPIC_API_KEY`.
- **macOS TCC blocks `~/Documents` for launchd jobs.** Every agent worktree's
  git points back into `~/Documents/storyOS/.git`, so every git command would
  fail with `Operation not permitted`.

A session you open is already authenticated, already has your Documents grant,
and already has the right PATH. All three problems disappear.

## Starting one

```
cd ~/storyos-envs/<agent>          # marek, iris, ada, lena, vera, nadia, kai, nils
claude
```
then paste, in the session:
```
/loop 1h
```
followed by the contents of `~/storyos-envs/bin/<agent>.txt`.

That is the whole procedure. The session fires hourly for as long as it stays
open, checks its own queue, drains it, and goes quiet when there is nothing.

Mira and Otto both run from `~/storyos-envs/readers`.

## Watching them

Work is visible in StoryOS, not in a log file:

- `storyos/agent_runs` — one row per run
- the `Next` field on any ticket — whose queue it is in right now
- `storyos/uat_scenarios` — what Nadia and Kai have covered

## Stopping one

Close the session, or tell it to stop looping. There is nothing to unload.

## Order to start them in

1. **Vera** — her queue is empty, so a correct first tick is one line saying
   "idle" and nothing else. Proves the loop and the queue query for free.
2. **Marek** — has #448. First agent to write code and auto-merge. Watch it.
3. The rest, once those two behave.
