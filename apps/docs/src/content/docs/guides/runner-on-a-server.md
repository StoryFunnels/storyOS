---
title: Running the Runner on a small Linux server
description: Put the StoryOS Runner on a small always-on Linux server so your agents keep working when your laptop is closed, and what that costs you in trust.
sidebar:
  order: 14
---

A laptop that sleeps is **offline**, and the agents it serves wait. If you want agents to work
overnight, run the [Runner](/guides/runner/) on a machine that is always on. A small Linux server
from any provider is enough: the Runner does little itself, because the work happens in Claude Code
and in your subscription.

This guide assumes you have read [The StoryOS Runner](/guides/runner/) and have a Linux server you
can reach over SSH, with systemd. It uses no provider-specific steps.

:::caution[Status, as of 10 November 2026]
Claude Code is the only tool the Runner supports today. The `@storyos/runner` package was not yet
on the npm registry when this was written, so the install step below cannot succeed until it is
published.
:::

## What you are trusting the server with

Read this before you start. The server will hold:

- **your Claude Code sign-in**, which is your subscription. Anyone who gets into that server as that
  user can use your subscription;
- **the runner token**, in `~/.storyos-runner/config.json`, a plain `0600` file;
- **everything your agents read**. An agent reads records as you, so the text of those records
  passes through the server and through Claude Code.

So: use a server only you control, give the Runner its **own Linux user**, log in with SSH keys
and not passwords, and do not share the account. The Runner opens no inbound port, so the only port
you need open is the one for SSH.

Agents running unattended also means nobody is watching when one acts. Read the open gap in
[The StoryOS Runner](/guides/runner/#security) first, and only run agents in workspaces whose rules
you know.

## 1. Prepare the server

1. Create a normal user for the Runner (not root) and log in as it.
2. Install **Node 22 or newer**, in whatever way you prefer, and check it:

   ```sh
   node --version
   ```

3. Install **Claude Code** by following Claude Code's own installation instructions, and check
   `claude --version`.

## 2. Sign Claude Code in with your subscription

Run `claude` once and sign in, following Claude Code's own instructions for a machine without a
browser. Then prove a real call works:

```sh
claude -p "say hi"
```

Do not trust `claude auth status` on its own: it can say you are signed in when the sign-in has
expired. If you pass `ANTHROPIC_API_KEY` anywhere in the Runner's environment, the Runner does not
forward it to the session, so the session uses your subscription.

## 3. Install and pair the Runner

Autostart needs a permanent install, not the `npx` cache:

```sh
npm install -g @storyos/runner
```

Get a 6-character code from StoryOS (in the web app, **Settings → Runners → Add a Runner**; see
[Adding and removing a Runner](/guides/adding-and-removing-a-runner/)), then:

```sh
storyos-runner pair
```

Type the code. The Runner prints what it found (`found    Claude Code ... signed in`), then waits.
Back in StoryOS, choose Claude Code and press **Done**, within 10 minutes of getting the code. On a
self-managed StoryOS add `--server https://your.server`, and give `--mcp-url` for the MCP service.

Check:

```sh
storyos-runner status
```

It should say `Paired: yes` and `Server: reachable. This Runner is active, using claude-code`.

## 4. Start it at boot

Install the systemd **user** unit the Runner writes for itself:

```sh
storyos-runner install-autostart
loginctl enable-linger $USER
```

`install-autostart` writes `~/.config/systemd/user/storyos-runner.service` and runs
`systemctl --user enable --now storyos-runner.service`. The `loginctl enable-linger` line is a step
you do: without it, a user unit stops when you log out and does not start at boot.

To read the unit before it is installed, run `storyos-runner install-autostart --print`. It looks
like this, with the paths of your install:

```ini
[Unit]
Description=StoryOS Runner: runs your hired agents on this computer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="/usr/bin/node" "/usr/lib/node_modules/@storyos/runner/dist/index.js" start
Restart=on-failure
RestartSec=30
Environment="PATH=/usr/bin:/bin"

[Install]
WantedBy=default.target
```

Three things follow from it:

- **`Restart=on-failure`.** A crash restarts after 30 seconds. `storyos-runner stop` exits cleanly,
  so the unit stays stopped until you start it.
- **The Node path is fixed when you install the unit.** If you later move or replace Node, run
  `storyos-runner install-autostart` again.
- **The unit carries your `PATH` at install time**, which is how the Runner finds `claude`. If you
  install Claude Code afterwards somewhere not on that `PATH`, install the autostart again from a
  shell where `claude` resolves. No secret is in the file.

## 5. Check that it is online

- On the server: `systemctl --user status storyos-runner` and
  `tail ~/.storyos-runner/logs/runner.log`. A healthy Runner logs that it started, and idles while
  it waits for work.
- In StoryOS: your Runner shows as connected and not offline. StoryOS marks a Runner offline
  after 2 minutes without a sign of life, and sends you one notification per episode when agents
  are assigned to it. **Settings → Runners** shows its status line, and
  `GET /api/v1/workspaces/{ws}/runners` (or the MCP tool `list_runners`) shows its connection and
  `offline_since`.
- End to end, hand an agent a record and watch the comment arrive. To check the install without
  real work, stop the service (`systemctl --user stop storyos-runner`; only one Runner runs per
  computer) and run `storyos-runner start --adapter stub` in the foreground. It claims and reports
  wakes without doing anything, so use it on a test agent, then start the service again.

## Updating

```sh
npm install -g @storyos/runner@latest
systemctl --user restart storyos-runner
```

If StoryOS says the Runner is too old for the server (`This Runner is too old for this StoryOS
server`), this is the fix. A restart abandons a run in progress: StoryOS puts the wake back in the
queue after the 90-second lease, and the agent runs it again.

Claude Code needs updating too, and the Runner has only been verified against Claude Code **2.1.104**
(see the known risk in [The StoryOS Runner](/guides/runner/#security)). After you update Claude Code,
check that an agent still comments.

## Taking it away

Remove the Runner in StoryOS first (its token stops working at once), then on the server:

```sh
storyos-runner uninstall-autostart
rm -rf ~/.storyos-runner
```

Then sign Claude Code out on the server, or delete the server, so your subscription sign-in does not
stay on a machine you no longer use.
