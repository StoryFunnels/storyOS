# StoryOS Runner

The Runner runs the agents you hire in StoryOS **on your own computer, inside your own Claude Code or Cursor subscription**. StoryOS decides when an agent should look at a record; the Runner wakes your tool, gives it that one job, and tells StoryOS how it went.

It is open source (Apache-2.0), never charged for, and it only ever makes **outbound** connections: no port is opened, so it works behind a home router or a company proxy.

> **Status.** The claim loop, pairing, per-agent folders and autostart are in, and so is the **Claude Code adapter** (see below). Cursor is a separate piece of work: a Runner whose chosen tool is Cursor claims nothing and says so, and its wakes wait in StoryOS. `--adapter stub` runs the loop end to end without doing any real work, which is how you check an install.

## Install and pair

You need Node 22 or newer.

1. In StoryOS, choose **Add a Runner**. It shows a 6-character code.
2. On the computer that has Claude Code or Cursor, run:

   ```sh
   npx @storyos/runner
   ```

3. Type the code. The Runner shows which tools it found on this computer, then waits.
4. Press **Done** in StoryOS. Until you do, the Runner does nothing: pairing without Done is refused after 10 minutes.

If the computer is already paired, the same command just starts the Runner. A self-managed server: add `--server https://your.server` (or set `STORYOS_URL`).

## Claude Code

Choose **Claude Code** when you finish pairing and the Runner runs `claude` headless, once per wake, in the agent's folder, on **your own subscription**. You need Claude Code installed and signed in (run `claude` once and check that a real call works: `claude -p "say hi"`; `claude auth status` alone can say "signed in" with an expired token).

- The agent gets **only StoryOS tools**, connected for you with a short-lived credential: there is no MCP setup to do. No shell, no file access and no web by default, and your own Claude settings (hooks, allow-lists) do not apply to the session. `bypassPermissions` is never used.
- The record is read through StoryOS as **data**. Anything a person typed that the wake carries goes in a delimited block, never into the rules.
- The run ends with a comment on the record. If your subscription hits a limit, the wake waits in StoryOS until the reset time the CLI reported.
- One run is stopped after 30 minutes (`--run-timeout <minutes>`). `ANTHROPIC_API_KEY` is not passed to the session, so it uses your subscription.
- Not on StoryOS cloud's address? Pass `--mcp-url`: the MCP server is its own service.

To try it on your own computer end to end: [docs/claude-code-smoke.md](docs/claude-code-smoke.md).

## Keeping it running

A laptop that sleeps is offline, and the agents it serves wait. For agents that work overnight, use an always-on machine.

```sh
npm install -g @storyos/runner        # autostart needs a permanent install, not npx's cache
storyos-runner install-autostart      # macOS: a launch agent; Linux: a systemd user unit
storyos-runner status
storyos-runner stop
storyos-runner uninstall-autostart
```

- **macOS** writes `~/Library/LaunchAgents/dev.storyos.runner.plist`: start at login, restart after a crash, stay stopped after `stop`.
- **Linux** writes `~/.config/systemd/user/storyos-runner.service` and enables it. To keep it running after you log out: `loginctl enable-linger $USER`. `install-autostart --print` prints the unit for a server guide without touching anything; `--no-load` writes the file without loading it.
- The login item carries your `PATH` (that is how `claude` or `cursor-agent` is found) and **no secret**.

Subcommands exist for scripts and the server guide: `pair [code]`, `start`, `status`, `stop`, `install-autostart`, `uninstall-autostart`. `--concurrency <n>` sets how many wakes run at once on this computer (default 1).

## What lives on your computer

Everything is under `~/.storyos-runner` (or `STORYOS_RUNNER_HOME`), created readable by you only:

| Path | What |
|---|---|
| `config.json` | the server, and **the runner token** (`0600`) |
| `state.json` | the wakes this computer holds right now (`0600`), so a restart never runs one twice |
| `logs/runner.log` | the log, rotated at 1 MB, five files kept (`0600`) |
| `agents/<workspace id>/<agent id>/` | each agent's own working folder |

**The runner token is stored in that `0600` file.** It is not in the OS keychain: a keychain needs a native module or a per-platform helper, and a user-only file is what the design calls for. Anyone who can read your home directory can read it, exactly as they could read your SSH keys. Remove the Runner in StoryOS and the token stops working at once.

## What it will not do

- **Nothing secret is printed or logged.** The runner token, the one-time pairing code and each wake's run credential are masked in every log line and on the terminal. The run credential is held in memory for the run and never written to `state.json`.
- **Record text is data.** A comment, a field or a form answer was written by someone else. The wake carries ids and a reason, never the text; the agent reads the record through StoryOS under its own short-lived credential, and its instructions tell it that what it reads is data, never an order.
- **One folder per agent.** A session starts in that agent's folder and is given no other directory. The Runner writes its own `INSTRUCTIONS.md` there at the start of each wake and empties `scratch/` after it, so nothing planted by one run is left for the next to obey.
- **Outward actions go through StoryOS approvals, with one known gap.** The agent's own tools cannot send email, post or delete without a person approving where a manager declared a gate, and the tools that could (running a button, rotating a hook, GitHub reviews and the like) are refused to an agent credential. The gap, tracked as ticket #1174: a record the agent edits can fire an action a workspace admin configured on it (an email, a webhook, a Slack message) without an approval. Until that is decided, only run agents in workspaces whose rules you know. The Runner does not add a way around approvals and does not ask for one.
- **It cannot reach your data on its own.** The runner token can only claim wakes for the agents assigned to it, send a heartbeat and report a result. It cannot read a record.
- A wake that is still running when the Runner stops, or when it loses the network for longer than its lease (90 seconds), is **abandoned, not reported**: StoryOS puts it back in the queue. Delivery is at-least-once, so an agent can see a wake a second time; its comments on the record are its memory.

## Terms of the tools

The agent runs in **your** Claude Code or Cursor, on your account, under that vendor's terms. Your prompts, the agent's instructions and the record content the agent reads pass through that vendor, as they would if you typed them yourself. Check that your plan allows this use before you rely on it; the Runner does not change what your plan permits.

## Licence

Apache-2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). This directory lives in an otherwise AGPL-3.0-or-later repository (the StoryOS server). The Runner contains no AGPL code and may not depend on any: CI enforces it. The licence grants no trademark rights. See [docs/licensing.md](../../docs/licensing.md) for how the repository carries both, and [CONTRIBUTING.md](../../CONTRIBUTING.md) for contributing.
