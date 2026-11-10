---
title: "Settings: Connections"
description: One page and one card per provider under Integrations, Meta, X and LinkedIn as Custom API presets, plus API tokens and Webhooks.
sidebar:
  order: 4
---

The **Connections** group has three pages: **Integrations** (admins), **API tokens** (admins and
members) and **Webhooks** (admins). See [Settings](/settings/overview/) for who sees what.

## Integrations: one page per provider

**Settings → Integrations** lists what is connected to the workspace, with anything that needs
attention first, and an **Add a connection** list of the rest. Each row opens that provider's page. The
pages are: GitHub, Linear, Slack, YouTube, Google Calendar, Shopify, Email, Custom API, Meta, X,
LinkedIn, Apify, OpenAI, and Delegate to agent.

There used to be a separate **Connections** page that held the saved credentials. It is gone; every
credential now lives on the page of the provider it belongs to, and `/connections` redirects (see
[old settings URLs](/settings/overview/#old-settings-urls)).

Every provider page draws the same **connection card**, so connecting, testing and disconnecting work
the same way everywhere:

- **Connect** (or the provider's own label, such as **Connect Shopify**) when nothing is connected.
- A status pill: **Working**, **Needs a look**, **Expired**, **Revoked** or **Not working**, with a
  one-line reason where the server gave one.
- **Test** checks the connection. A saved connection is tested with the server's own test. Slack
  sends a test message. GitHub, when connected as the GitHub App, asks GitHub for the installation's
  repositories; a personal access token has no live check yet, and the page says so. Linear shows
  **Refresh status** instead: it reads the last sync StoryOS recorded and does not call Linear. A
  check that did not call the provider is reported as information, never as a pass.
- **Reconnect**, for a connection that signs in through the provider and is no longer active.
- **Disconnect**, which asks first and names what will stop. For example, disconnecting Shopify stops
  its syncs while the databases and records already created stay.

A provider that cannot be connected on your instance says why on its card instead of offering a button
that fails. On a self-managed instance a provider that needs its OAuth app configured shows
that it needs the operator; see [self-hosting integrations](/self-hosting/configuration/#integrations-whats-available-self-hosted).
A connection that was paused after repeated failures shows "Paused until {time}" in its card's
advanced details, with a **Resume** button for when the cause is fixed.

Email (Resend or SMTP), Custom API, Apify and OpenAI have a page that is only the card; the page says
what to do next, for example choosing the connection in a Send email button or automation action.

## Meta, X and LinkedIn are Custom API presets

Meta (Facebook and Instagram), X and LinkedIn are Custom API connections with their address and
token hint filled in. Their pages offer **Connect Meta**, **Connect X** and **Connect with a token**
(LinkedIn). Each preset sets a default connection name, the API address it sends to, and says what
token to paste:

| Preset | Token to paste |
|---|---|
| Meta | A long-lived Page access token with the `pages_read_engagement` permission. |
| X | An OAuth 2.0 user token with the `tweet.read` and `users.read` scopes. |
| LinkedIn | An organization access token with the `r_organization_social` scope. |

A saved connection whose name marks it as Meta, X or LinkedIn is listed on that preset's page, and
all other HTTP connections on **Custom API**, so each connection appears once. LinkedIn also has a
**Connect LinkedIn** sign-in button beside the token option. X's page lists a connection created
through the API for posting, but does not offer a connect form for it.

## API tokens

**Settings → API tokens** lists your personal tokens for this workspace, with **Create API token**.
The token is shown once. It sits in the Connections group; the address is still `/api`. See
[authentication](/api/authentication/).

## Webhooks

**Settings → Webhooks** (admins) is unchanged apart from its place in the menu; see
[webhooks](/guides/webhooks/).
