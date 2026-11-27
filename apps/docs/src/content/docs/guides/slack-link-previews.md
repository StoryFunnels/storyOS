---
title: Slack link previews
description: What Slack shows under a pasted StoryOS record link (the title and the state), which records never get a preview, and what a server operator configures in the Slack app.
sidebar:
  order: 7
---

When someone pastes a link to a StoryOS record into a channel of your Slack workspace, Slack can
show a small card under it: the record's **title** and its **state**. Nothing else.

## What the card shows

| Shown | Never shown |
|---|---|
| The record's title | Field values, the description, comments |
| The record's state (its Workflow field, or a single-select field named *State* or *Status*) | Who it is assigned to, dates, relations, attachments |

A title that contains Slack control text, such as `<!channel>`, is shown as plain text and pings
nobody. A record with no state shows the title alone.

## Which links get a card

A card appears only when **all** of these are true:

- The link is a record link into **the StoryOS workspace that installed the Slack app**. A link into
  a different StoryOS workspace gets no card, and neither does a link pasted in a Slack workspace
  that did not install the app.
- The record, its database and its space are all live. A record in the trash gets no card.
- The database and its space are **open to every member**. A [restricted](/concepts/access-and-roles/#restricting-a-space-or-database)
  space or database never gets a card, whatever the person who pasted the link can see in StoryOS.
- The database is an ordinary one: not the Members directory, and never anything in a personal space.

Slack tells StoryOS which Slack user pasted a link but not who that is in StoryOS, so the rule cannot
be "show it only to people who can open the record". It is about the record instead, and it is the
strictest rule StoryOS has for showing a record's title in a place whose readers it does not control.

A link to a record that is hidden, trashed or does not exist gets the same result: no card. Nobody
can tell the three apart from Slack.

## Setting it up

The person who runs the server does this once, in the Slack app and in the server's environment.

**On the server**, set the Slack app's signing secret (Slack, *Basic Information*, *App Credentials*,
*Signing Secret*) in the API's environment. Never put it in git.

```bash
SLACK_SIGNING_SECRET=<the app's signing secret>
```

With it unset, StoryOS refuses every request to the Slack endpoint, so no preview is ever shown. That is
deliberate: the signature is the only thing that proves a request came from Slack.

**In the Slack app** (api.slack.com/apps, your app):

1. **Event Subscriptions**: turn them on and set the **Request URL** to
   `{API_URL}/api/v1/integrations/slack/events`. Slack checks the URL immediately, so set the signing
   secret and restart the API first.
2. Under **Subscribe to bot events**, add **`link_shared`**.
3. Under **App unfurl domains**, add the host of your StoryOS web app (the host of `WEB_URL`, with no
   `https://` and no path, for example `os.example.com`).
4. **OAuth & Permissions**, bot token scopes: add **`links:read`** and **`links:write`**, then reinstall
   the app to the Slack workspace.

The workspace's Slack connection (Settings, Integrations, Slack) must hold the **bot token of that same
Slack app**. StoryOS asks Slack which Slack workspace that token belongs to, and that is the one whose
pasted links get cards. If two StoryOS workspaces hold a token for the same Slack workspace, nobody can
say which one installed the app, so neither gets previews.
