---
title: Post record changes to a Slack channel
description: Subscribe a Slack channel to a space or a database, so new records, status changes and comments appear in it without building an automation.
sidebar:
  order: 6
---

A **channel subscription** says: "when a record in this space or database is created, has its status
changed, or gets a comment, post one message in this Slack channel." It is one setting, not an
automation per event, and it needs no Slack app: it posts through the Slack connection the workspace
already has (a bot token or an incoming webhook, see [Connections](/settings/connections/)).

Listing, creating, changing and removing subscriptions is **admin-only**. A member or guest cannot see
which spaces and databases post to which channels.

## Subscribe a channel

You subscribe **either a space or a database**, never both in one subscription, and pick which of the
three events post:

| Event | Posts when |
|---|---|
| Created | a record is added (by a person, an agent or an automation) |
| Status changed | the database's status field changes: its **Workflow** field, or a single-select field named *State* or *Status* |
| Commented | a comment is added to a record |

A space subscription covers every database in the space. If a database in the space has its own
subscription to the **same channel**, that one wins, and the channel gets one message, not two, with
only the events the database subscription names.

A bot-token workspace needs a channel (a public channel's name such as `engineering`, or its id).
A workspace that posts through an **incoming webhook** has its channel fixed by the webhook, so you
leave the channel empty.

## What a message says

The record's **title** (with its identifier, such as `ISSUE-12`, when the database has them), its
**state**, **who** did it and a **link** back to the record. For a status change, the old and the new
state. Nothing else leaves StoryOS: no field values, no description, no comment text.

When an agent, an automation or the MCP made the change, the message says *via agent*,
*via automation* or *via MCP* next to the member's name. A sync from Linear says *via sync*.

Everything a person typed (a title, a name, a state) is posted as literal text, so a title containing
`<!channel>` does not ping the channel.

## What never posts

- **Personal space** content. A personal space cannot be subscribed.
- A **trashed** record, and anything in a deleted database or space.
- **Imports.** Importing records posts nothing for *created*, and a full or first import posts no
  status changes. A scheduled sync that read only what changed in the source (an *incremental* run,
  such as the Linear sync) does post the status changes it carries, marked *via sync*.
- A database that is **restricted**, when you subscribed its *space*. A space subscription does not
  reach into a restricted database. Subscribe that database itself to include it.

## Restricted spaces and databases

A restricted space or database can be subscribed, but the channel's members are not controlled by
StoryOS: the titles of its records will be visible to everyone in that channel. So creating the
subscription needs an explicit confirmation (`acknowledge_restricted`) that says so.

The record title posted is the one a member **without** access to the underlying data would see
(computed titles that look up values in a restricted database show a dash for them).

## When the person who made it loses access

A subscription posts on the authority of the admin who made it, and that is **re-checked on every
event**. If that person has been demoted or removed, the subscription **stops posting** and shows
*needs attention* (`creator_not_admin` or `creator_left`) in the list. It is never silently kept
alive and never silently dropped. An admin who edits it (even to save the same settings) takes it
over and it posts again.

## Delivery

- A message that fails is retried with a growing wait, three more times, and then counted on the
  subscription: `failed_count` and `last_error` (Slack's own error code, such as `channel_not_found`).
  A failed post never blocks or fails the change to the record.
- Slack allows about one message a second per channel. A burst beyond a small backlog is folded into
  **one line saying how many updates were held back**, never dropped without a word.
- The queue is held in memory. If the server restarts, messages that were waiting are lost; the counts
  only describe attempts that were made.

## Limits

- Public channels only. Private channels, direct messages and people are not supported.
- Removing a subscription stops its posts immediately. Removing the Slack connection (**Disconnect**)
  makes new subscriptions impossible and existing ones fail with an error you can see in the list.

## API and MCP

`GET /workspaces/{ws}/integrations/slack/subscriptions` lists them. Every route here needs an admin-scoped
token (an agent's per-run credential never has one). An agent holding an admin-scoped token can list them
with the MCP tool `list_slack_subscriptions`, to see what posts where. Creating, changing and deleting
have **no MCP tool**: choosing where a workspace's records are sent is a person's decision.
