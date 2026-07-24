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
