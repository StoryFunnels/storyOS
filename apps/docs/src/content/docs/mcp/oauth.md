---
title: OAuth connector
description: Let cloud clients connect the hosted StoryOS MCP endpoint with a one-click OAuth sign-in instead of pasting a personal access token.
sidebar:
  order: 5
---

The [hosted MCP endpoint](/mcp/hosted/) accepts a personal access token in the `Authorization`
header. For a smoother experience, StoryOS can also act as an **OAuth authorization server** so
clients that support MCP connectors (claude.ai, ChatGPT) let a user **sign in once** and authorize
the connector — no token to copy or paste.

## How it works

When OAuth is enabled, the MCP endpoint advertises OAuth discovery metadata. A connecting client
then:

1. Discovers the authorization server (your StoryOS app).
2. Sends the user through a normal sign-in + consent flow.
3. Receives a scoped token and calls `POST /mcp` with it — exactly like the PAT flow, but the
   credential is minted by the authorization step instead of pasted by hand.

The authorization is still scoped to the user's [role and space grants](/concepts/access-and-roles/),
so the connector can only touch what the user can.

**A connected AI has no scope or resource ceiling, by design.** It acts with the full access of the
person who connected it, so what it can do equals what you can do. It is your hands, not a separate
party, and StoryOS does not narrow it. Its changes are recorded as coming from an AI (`mcp`), not as
a person's.

- **To revoke it, disconnect it.**
- **Approval gates still apply** to what a connected AI does, exactly as they do for a personal
  access token: an action a [gate](/concepts/approval-gates/) holds waits for a person.
- **To narrow an AI on purpose, give it a personal access token instead.** A
  [token](/api/authentication/) can be capped at read, write or admin power and bound to specific
  spaces or databases. That is for delegating to a script or a tool, not for your own AI.

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
   choose the **one workspace** it may reach and whether it can **read only** or **read and write**,
   then click **Allow**. If your client cannot open a sign-in page, use a
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
`https://mcp.storyos.dev/mcp` (or your self-hosted URL) and complete the sign-in prompt. The client
handles the token exchange for you.

:::note
Prefer the manual route, or using a client without connector support? The
[PAT header method](/mcp/hosted/) works everywhere and needs no OAuth configuration.
:::
