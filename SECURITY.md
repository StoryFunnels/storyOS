# Security policy

## Reporting a vulnerability

**Please do not report security problems in a public issue, pull request, discussion or comment.**

Report them privately through GitHub: open the **Security** tab of this repository and click
**Report a vulnerability** ([direct link](https://github.com/StoryFunnels/storyOS/security/advisories/new)).
Only the maintainers can see the report.

A useful report says:

- what an attacker can do, and what they need first (an account? a role? nothing?)
- the steps or request that show it, against a local copy or your own workspace
- the commit or version you tested

## What to expect

- We confirm we received your report and keep you posted while we fix it.
- We fix it on `main` first and deploy it to the hosted service.
- We publish an advisory once the fix is live, and credit you if you want to be named.

## Scope

In scope:

- this repository's code (API, web app, MCP server, packages)
- the hosted service at `app.storyos.dev`, `docs.storyos.dev` and `mcp.storyos.dev`, **only in workspaces you own**

Please don't:

- access, change or delete other people's data; use your own accounts and workspaces
- run load tests, denial-of-service or spam against the hosted service
- use social engineering or physical attacks against the team

Good-faith research that follows these rules is welcome, and we will not take action against you for it.

## Supported versions

Only the latest `main` (and what is deployed from it) receives security fixes. If you self-host, update to the latest `main`.
