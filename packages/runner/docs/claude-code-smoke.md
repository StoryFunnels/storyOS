# Claude Code adapter: run one real wake on your Mac

This is the manual test for ticket #1135. It has one purpose: see an agent, running in **your own logged-in Claude Code**, read a record, comment on it and hand off, and see the tokens land on the run record.

Read "What was and was not tested" at the bottom first: the adapter was exercised against a fake `claude` and a real local server with a scripted stand-in for the model. **You are the first person to run it with the real model.**

## 0. Before anything: is Claude Code actually signed in?

`claude auth status` can say `loggedIn: true` while the token has expired (this is what happened on the machine the adapter was built on). Test a real call:

```sh
claude -p "say hi in one word"
```

If that prints an authentication error, run `claude` once interactively and sign in. The Runner never signs in for you and never touches your Claude credentials.

## 1. The server side is not merged yet

The Runner API lives in three open PRs that must merge in this order: **#1355 -> #1360 -> #1362 -> the adapter PR**. Until they are on `main` (and deployed) the hosted app has no Runner API, so test against a server you run from this branch. The rest of this page does that, on your own computer, with a throwaway database.

```sh
git checkout runner/1135-claude-code-adapter     # or use a worktree
pnpm install --frozen-lockfile
pnpm --filter @storyos/schemas build && pnpm --filter @storyos/sdk build
pnpm --filter @storyos/runner build
createdb storyos_smoke_1135
export DATABASE_URL="postgres://$(whoami)@localhost:5432/storyos_smoke_1135"
pnpm --filter @storyos/api db:migrate
```

Start the API and the MCP server (two terminals), on ports of your choosing:

```sh
# terminal 1
pnpm --filter @storyos/api build
cd apps/api && PORT=3001 API_URL=http://127.0.0.1:3001 WEB_URL=http://127.0.0.1:3000 node dist/main.js

# terminal 2
cd packages/mcp && PORT=3002 STORYOS_URL=http://127.0.0.1:3001 pnpm exec tsx src/http.ts
```

**Why two servers:** the claim response carries no MCP address, and on a self-managed install the MCP server is its own service (`mcp.<your-domain>/mcp`), not `<server>/mcp`. The Runner assumes the hosted address (`https://mcp.storyos.dev/mcp`) when you do not say otherwise, so **always pass `--mcp-url`** against anything else.

## 2. One command: the whole wake

```sh
SMOKE_API=http://127.0.0.1:3001 SMOKE_MCP=http://127.0.0.1:3002/mcp SMOKE_DB=storyos_smoke_1135 \
  node packages/runner/docs/smoke-local.mjs
```

It creates a throwaway account, workspace, agent (AI mode "Your own AI", scope `write`) and one lead; pairs the built Runner; assigns the agent; starts the Runner; hands the lead to the agent; waits up to 10 minutes; and prints what happened. It refuses any API address that is not on this computer. It needs `psql` on your PATH (to read select-option ids).

**Cleaning up: only the paths this script printed.** The script makes ONE directory for itself (it prints `This run's own directory ...`), keeps everything it creates inside it, and on a clean finish removes only that. If a run fails, or you set `SMOKE_KEEP=1`, it keeps the directory and prints its exact path: delete only that path. Never clean up with a pattern such as `rm -rf /tmp/storyos-smoke-runner-*` or a temp-dir glob: other sessions' throwaway runner homes live next to yours and look the same. The throwaway database and the local API/MCP processes you started are yours to stop by hand; the script does not touch them.

**Version check.** The adapter relies on an undocumented `claude` setting (`MCP_CONNECTION_NONBLOCKING=0`, see "Known risk" in the README). The script checks `claude --version` against the list of verified versions (`VERIFIED_CLI_VERSIONS` in `src/adapters/claude-code/pins.ts`, the same list the package test uses) and refuses to run on any other, unless you set `SMOKE_ALLOW_UNVERIFIED_CLI=1`; then watch for `mcp storyos=pending` in the log.

### What you should see

1. `found    Claude Code 2.1.x, signed in` while pairing, then `Done. This computer is ready and will use claude-code.`
2. In the Runner log, one `claimed wake ...` line, then one line like
   `wake ...: claude-code ok; N turns, tools used: mcp__storyos__get_record, mcp__storyos__add_comment; tokens X in / Y out; mcp storyos=connected; permission mode dontAsk`
   then `reported ok`. The log never contains the run credential, a prompt, a tool input or the agent's text.
3. `wake status: done`, a `run record:` line with `tokens_in` and `tokens_out` **filled in** (not "not reported"), a `session_id`, and a summary.
4. A comment on the lead from the agent (`source agent`). That comment is the hand-off.

### What would be wrong

| You see | Meaning |
|---|---|
| `Claude Code on this computer is not signed in, or its sign-in has expired` | step 0 |
| `mcp storyos=failed` / `could not connect to the StoryOS MCP server` | wrong `--mcp-url`, or the MCP server is not running |
| `the allowlist refused: Bash` | the model tried a tool this agent may not use; it was refused by the CLI. Expected only if you told the agent to run commands |
| `wake status: queued, not before: <later>` and the log says `usage limit; lifts <time>` | your subscription hit a limit; StoryOS holds the wake until the reset. Correct behaviour |
| `tokens_in=not reported` | the CLI produced no result event; please send me the Runner log |
| no comment on the lead, wake `done` | the agent finished without commenting; StoryOS re-runs it once (`must_comment`) and then tells the owner |

### Reading the log

The Runner log is printed to the terminal and kept at `<runner home>/logs/runner.log` (the script prints the path). To see exactly what the CLI was asked, read `packages/runner/src/adapters/claude-code/index.ts` (`execute`): every flag is in one array.

## 3. Doing the pairing by hand

Useful when you want to pair a Runner to a server you already have. **These routes need a signed-in session, not an API token**: `POST .../runners/pairing-codes`, `.../runners/:id/activate` and `PUT .../runner-assignments/:agent` answer 403 to a personal access token (by the code, `runners.controller.ts` `assertPerson`; I did not try it: "an API token or a connected AI cannot do it": a Runner decides where your agents' work and data go). So the `$STORYOS_PAT` you may have in mind will not work here. The web screen for this ("Add a Runner", ticket #1139) is the normal way once it ships. Until then, with your own session bearer token in `$STORYOS_SESSION` (the value of the `set-auth-token` header that sign-in returns; you obtain it yourself, nobody else needs it):

```sh
export STORYOS_URL=http://127.0.0.1:3001      # your server
export WS=<your workspace id>
# 1. a 6-character code, valid about 10 minutes
curl -s -X POST "$STORYOS_URL/api/v1/workspaces/$WS/runners/pairing-codes" -H "authorization: Bearer $STORYOS_SESSION" -H 'content-type: application/json' -d '{}'
# 2. on this computer (the Runner shows what it found, then waits for "Done")
node packages/runner/dist/index.js pair <code> --server "$STORYOS_URL" --mcp-url http://127.0.0.1:3002/mcp
# 3. "Done": choose Claude Code. The tool id is "claude-code" (hyphen). It must be one the Runner found on this computer.
curl -s -X POST "$STORYOS_URL/api/v1/workspaces/$WS/runners/<runner id>/activate" -H "authorization: Bearer $STORYOS_SESSION" -H 'content-type: application/json' -d '{"tool":"claude-code"}'
# 4. send an agent to the Runner. The agent's AI mode must be "Your own AI" (422 otherwise).
curl -s -X PUT "$STORYOS_URL/api/v1/workspaces/$WS/runner-assignments/<agent id>" -H "authorization: Bearer $STORYOS_SESSION" -H 'content-type: application/json' -d '{"runner_id":"<runner id>"}'
# 5. start it, then wake the agent (run_agent, a state change into its trigger state, an @mention, or:)
node packages/runner/dist/index.js start --mcp-url http://127.0.0.1:3002/mcp
curl -s -X POST "$STORYOS_URL/api/v1/workspaces/$WS/agents/<agent id>/delegate" -H "authorization: Bearer $STORYOS_SESSION" -H 'content-type: application/json' -d '{"record_id":"<record id>"}'
```

Never paste a token into a chat, a ticket or a shell history line you keep: use the variable.

## What the session is allowed to do

- **Only StoryOS tools.** The StoryOS MCP server is the only tool source (`--strict-mcp-config`), reached with the run credential: an agent token capped at `write`, valid for this run only.
- **No local tools by default.** No shell, no file read or write, no web (`--tools ""`, plus an explicit deny list). A manager can allow a specific native tool for one agent; today nothing sends that setting, so it is always empty.
- **No bypass.** `--permission-mode dontAsk`: a tool that is not allowed is refused without asking. `bypassPermissions` and `--dangerously-skip-permissions` are never passed.
- **Your own settings do not apply to the session** (`--setting-sources ""`): your hooks, your `permissions.allow`, your skills. A `settings.json` that allows `Bash` for your own work must not reopen it for an agent driven by text other people wrote.
- **The credential** is in the session's environment only: not in the command line, not in a file (the MCP config file, mode 0600, holds the variable's *name* and is deleted afterwards).
- **Your subscription.** An `ANTHROPIC_API_KEY` in your environment is removed from the session so the CLI does not bill an API key (set `STORYOS_RUNNER_CLAUDE_KEEP_API_KEY=1` to opt out).
- **Time.** One run is stopped (the whole process group) after 30 minutes: `--run-timeout <minutes>` or `STORYOS_RUNNER_RUN_TIMEOUT_MINUTES`.
- Agent instructions and skills are in the system prompt, so anyone who can run `ps` on this computer can read them. They are not a place for secrets (ADR-0021).

## What was and was not tested

Tested for real:

- The `claude` flags the adapter passes were accepted by the real CLI (2.1.104) together, with stdin, and the CLI reached the API (then failed: expired login).
- The MCP injection against the real CLI: config with `Bearer ${STORYOS_RUN_TOKEN}`, the CLI connected and sent the env value as the Authorization header; with `--tools ""` its tool list was exactly the MCP tools.
- A real API, a real MCP server and the built Runner over HTTP: pair, activate with `claude-code`, assign, wake, claim, MCP calls with the run credential (a comment landed as source `agent`), completion with tokens and session id on the Run record, a limit stop requeueing the wake to the reset time. **The model in that run was a scripted stand-in**, not Claude.
- A fake `claude` in unit tests: every success and failure shape, timeout and group kill, abort, injected text.

Not tested (yours to find out):

- A real model doing the job end to end, and real token counts.
- A real subscription limit stop: the `rate_limit_event` / `resetsAt` / `error: rate_limit` shapes are read from the CLI binary's schema, never seen from a live limit. If your limit stop does not requeue, send the Runner log.
- That the CLI refuses a tool outside the allowlist (the adapter passes the right flags; enforcement is the CLI's). The denial entry shape in `permission_denials` is also unconfirmed.
- Anything on Windows.
