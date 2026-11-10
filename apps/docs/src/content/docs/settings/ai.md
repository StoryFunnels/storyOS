---
title: "Settings: AI"
description: Reconnect an AI app that needs it, and set the workspace's agent rules, including whether AI may share skills with everyone.
sidebar:
  order: 3
---

The **AI** group has three pages: **Connect your AI** and **Runners** (admins and members), and
**Agent rules** (admins). See [Settings](/settings/overview/) for who sees what.

## Reconnecting an AI app

**Settings → Connect your AI** lists the AI apps connected to your account in an **AI apps** box,
with a **Disconnect** button on each. When the server reports that an app's earlier approval no longer
applies, that app shows **Not working** and **Reconnect needed**, and the box heading says how many
("7 · 3 need reconnecting"). The same count shows as **to fix** beside Connect your AI in the
Settings menu and on the Settings home.

The causes the page names are the ones the server reports: the app was connected before approval
existed, was never approved, or was approved with a read-only level that has since been removed. The
page does not say more than that.

To fix one, press **Reconnect** on its row. StoryOS cannot restart the sign-in for the app, so the
panel tells you what to do in the app itself: remove the **StoryOS** connector, add it again with the
two values shown (**connector name** and **server address**, each with a copy button), and approve
StoryOS when asked. Then press **I've done it, check again**. The row stops saying it needs a
reconnect only once the server says it is approved; if not, the panel says "Still not approved". For
the guides to connect Claude or ChatGPT in the first place, see the [OAuth connector](/mcp/oauth/).

Only apps in this state get **Reconnect**. Disconnecting a not-working app removes it; connect it
again to choose its workspaces.

## Agent rules

**Settings → Agent rules** (admins) replaces the page that was called **Governance**; the old address
`/governance` redirects to it. The page is headed "What AI may do in this workspace without asking a
person". From the top:

- **Default model for agents.** The workspace's default model.
- **Let AI share skills with the whole workspace.** A switch. On, a skill an AI writes is shared with
  the workspace straight away and always marked as AI-written. Off, AI-written skills stay private to
  the person whose AI wrote them. Skills already shared stay shared. It is on until an admin turns it
  off, and only a person can change it: the web app is the way, not an API token or a connected AI.
  This switch used to be on General. See [skills](/concepts/skills/) for what sharing means.
- **Agents**, **Gates in force**, **Always enforced** and **What this page cannot show**: the read-only
  view of what the server enforces, as before. Nothing in these sections widens a scope or decides an
  approval. See [approval gates](/concepts/approval-gates/).

**Runners** is covered in [the Runner guide](/guides/runner/).
