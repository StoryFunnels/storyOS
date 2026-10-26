---
title: OAuth connector
description: Let cloud clients connect the hosted StoryOS MCP endpoint with an OAuth sign-in and an Allow page instead of pasting a personal access token.
sidebar:
  order: 5
---

The [hosted MCP endpoint](/mcp/hosted/) accepts a personal access token in the `Authorization`
header. For a smoother experience, StoryOS can also act as an **OAuth authorization server** so
clients that support MCP connectors (claude.ai, ChatGPT) let a user **sign in and allow** the
connector: no token to copy or paste, and nothing is connected until the person says so.

## How it works

When OAuth is enabled, the MCP endpoint advertises OAuth discovery metadata. A connecting client
then:

1. Discovers the authorization server (your StoryOS app).
2. Sends the user through sign-in and then **always** to an **Allow page**. It names the client, the
   host the result is sent back to and what is being asked. By default the connection reaches **all
   your workspaces**; the person can choose **One workspace** instead. Nothing is connected until
   they click **Allow**; **Deny** tells the client `access_denied`. The server forces this step, so a
   client cannot skip it.
3. Receives a token and calls `POST /mcp` with it, exactly like the PAT flow, except the credential
   is minted by the authorization step instead of pasted by hand.

## What a connection can reach

A connection is always an approved one, and it always has the full set of tools: **there is no
read-only choice**. What the person approves is which workspaces it reaches, enforced on every
request:

- **All your workspaces (the default).** Including any you join later. Your role and access in each
  still apply.
- **One workspace (optional).** The connection is bound to the workspace chosen; asking for any
  other answers `404`, as if it did not exist.
- **Tool limits are the client's job.** To stop an AI using certain tools, switch them off in the
  client (for example in Claude's connector settings). StoryOS does not offer a read-only level.
- **Still the person's access, never more.** The connection is limited by the person's own
  [role and space grants](/concepts/access-and-roles/) as well, so it can only touch what both the
  approval and the person allow.
- **Approval gates still apply** to what a connected AI does, exactly as they do for a personal
  access token: an action a [gate](/concepts/approval-gates/) holds waits for a person.
- **Its changes are recorded as an AI's** (`mcp`), under the person's name, not as the person's own.

**Seeing and removing connections.** Under **Settings → Connect your AI**, **Connected AI clients**
lists each connection with what it reaches (**All your workspaces**, or the one workspace), and
**Disconnect** ends it immediately. A client that connects again goes through the Allow page again.

**Older connections** (made before the Allow page existed, or approved as read-only or bound to one
workspace under the earlier rules) are refused until the client is reconnected and approved again.
The list shows them as **Reconnect needed**.

**To narrow an AI differently, or for a script or a tool, use a personal access token.** A
[token](/api/authentication/) can be capped at read, write or admin power and bound to specific
spaces or databases.

## Connect any other client

Claude and ChatGPT have step-by-step guides on **Settings → Connect your AI**. For any other app or
command-line tool that can connect to a **remote MCP server**, pick **Other** on that page. It shows
the same three things every client needs:

1. **Add a remote MCP server** in your client (it may call it a connector, a custom connector or an
   MCP server). It must support remote servers over streamable HTTP; a tool that can only run a
   local command cannot use the address.
2. **Name** it `StoryOS`, and paste the server **address** (`https://mcp.storyos.dev/mcp` on the cloud
   instance, or your own).
3. **Sign in with OAuth** (recommended). StoryOS opens a page asking you to allow the connection:
   it reaches all your workspaces unless you choose **One workspace**; click **Allow**. If your client cannot open a sign-in page, use a
   [personal access token](/api/authentication/) instead, from **Settings → API tokens** (shown once),
   sent as `Authorization: Bearer …`. Never paste a token into a sign-in page.

A client that signs in through your browser may use a loopback address (`http://127.0.0.1:<port>`) or
its own app scheme as its redirect; StoryOS checks it against what the client registered.

## Enable it (self-host)

OAuth is off unless you turn it on. It requires the OIDC tables to be migrated, then set these
environment variables (see the [configuration matrix](/self-hosting/configuration/)):

| Variable          | Service         | Value                                                                           |
| ----------------- | --------------- | ------------------------------------------------------------------------------- |
| `MCP_OAUTH`       | `api` and `mcp` | `true` — enables OAuth discovery advertising.                                   |
| `MCP_PUBLIC_URL`  | `mcp`           | Public URL of your MCP endpoint, e.g. `https://mcp.your-domain.com`.            |
| `MCP_AUTH_SERVER` | `mcp`           | Better Auth's mounted base URL, e.g. `https://app.your-domain.com/api/v1/auth`. |

On the cloud instance this is `https://mcp.storyos.dev` (endpoint) with
`https://app.storyos.dev/api/v1/auth` as the authorization server. The authorization server advertises
`offline_access` for refresh tokens and the dedicated `storyos.mcp` scope.

## Connect

In a client that supports MCP connectors, add a connector pointing at
`https://mcp.storyos.dev/mcp` (or your self-hosted URL), sign in, and click Allow (all your workspaces,
or choose One workspace). The client handles the token exchange for you.

:::note
Prefer the manual route, or using a client without connector support? The
[PAT header method](/mcp/hosted/) works everywhere and needs no OAuth configuration.
:::
