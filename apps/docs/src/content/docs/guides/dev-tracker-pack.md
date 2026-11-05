---
title: The Dev Tracker pack
description: What the built-in Dev Tracker pack creates, its four views, who gets told when an issue is assigned, what its Triage agent can and cannot do on its own, and when it cannot be installed.
sidebar:
  order: 13
---

**Dev Tracker** is a built-in Business Pack for a team that builds software and wants bugs and features in
one queue. Its slug is `dev-tracker`. It installs into a space named **Product** unless you
[choose another space](/mcp/tools/#installing-a-pack-into-an-existing-space). It sits beside **Dev Project
OS** in the gallery and does not change it. It declares that it needs your own AI, for its Triage agent.

## What it creates

Four databases:

| Database | Fields |
|---|---|
| **Issues** | **State**, **Priority** (Urgent, High, Medium, Low), **Assignee** (a person), **Labels** (Bug, Feature, Improvement, several allowed), **Estimate** (a number), **Due date**, **Project**, **Sprint**, **Release** (links to those databases) and **Parent issue** / **Sub-issues** (links to other issues) |
| **Projects** | **State**, **Lead** (a person), **Target date**, **Issues** (every issue in the project) |
| **Sprints** | **Number**, **Start date**, **End date**, **Issues** |
| **Releases** | **Status** (Planned, Released), **Release date**, **Issues** |

An issue's **State** has seven options, each with a category: **Triage** and **Backlog** are backlog, **To Do** is
unstarted, **In Progress** and **In Review** are started, **Done** is completed and **Canceled** is canceled. Triage
is the first option, so a new issue lands in it. A project's **State** has Backlog, Planned, In Progress, Paused,
Completed and Canceled. See [Option categories](/guides/pack-manifest/#option-categories).

A release's own page (the body of its record) is where you write its changelog.

## The four views

- **Active** on Issues, a board grouped by State that shows only issues in **To Do**, **In Progress** and
  **In Review**, with Priority and Assignee on each card. It is the view Issues opens on.
- **My issues** on Issues, a table grouped by State, showing the issues whose Assignee is the person looking
  at it and whose State is not Done or Canceled. That includes issues still in Triage or Backlog. It is one
  shared view: each teammate sees their own issues in it.
- **Triage** on Issues, a table of the issues in the Triage state, newest first by when they were created.
- **Projects** on Projects, a board grouped by the project's State, with Lead and Target date on each card.
  Projects keeps its own **All records** list as the view it opens on.

### Active still shows empty columns

On the Active board, the Triage, Backlog, Done and Canceled columns are drawn, and are empty, because the
view's filter keeps only three states. The pack hides the empty "no value" column and nothing else. Board
views can hide a column by option (`hidden_option_ids`), but this pack does not set it, so you hide the four
columns yourself if you do not want them.

## Telling the assignee

The pack installs two automations on Issues, both switched on. Each sends the new assignee the notification
"An issue was assigned to you."

- **Tell the assignee** runs when an issue's Assignee changes.
- **Tell the assignee of a new issue** runs when an issue is created, and only if its Assignee is not empty.
  A new issue with no assignee tells nobody.

An automation has one trigger, which is why the job is two rules: a change of Assignee does not fire for an
issue that is created already assigned. The four sample issues are added without running these rules, so
installing the pack tells nobody anything.

## The Triage agent

The pack adds an agent named **Triage**, owned by the person who installed the pack. Its goal is to read each
new issue in Triage, suggest its Labels and Priority, and flag a likely duplicate by naming the issue it looks
like. It has read and write scope, and its target database is Issues.

- **It runs on your own AI.** Its AI mode is **Your own AI**, which StoryOS does not meter. An agent in this
  mode does its work while your AI client is connected. See
  [Writing a pack manifest](/guides/pack-manifest/#agents-ai-mode-and-skills).
- **Its updates to Issues wait for a person.** The pack gives the agent a [write
  gate](/concepts/approval-gates/#gating-an-agents-record-writes) on updates to Issues. A held update is not
  written. It lands in the Inbox as an approval for the agent's owner, and applies exactly the values that were
  held if the owner (or a workspace admin) approves it.
- **The gate covers updates, not creates.** The pack declares the gate for the `update` operation only. The
  agent's instructions also tell it never to change an issue's State or Assignee, but that is an instruction
  to the AI, not something the platform enforces: the gate is what stops an update from landing unseen.
- **Entering Triage can start it, once you switch it on.** The agent is bound to Issues entering the Triage
  state. The binding installs switched off. In the install review, choose to wake the agent automatically, and
  from then on a new issue in Triage starts a run by itself, with nobody starting it. Left off, nothing starts
  by itself, and you can still start a run yourself, for example with the MCP `run_agent` tool (see
  [MCP tools](/mcp/tools/)). The pack's binding is not a human gate; the human-gate option, "ask me before
  each run", stays available on bindings you create yourself.

Uninstalling removes the agent along with the pack's views and automations. See
[Uninstalling a pack](/mcp/tools/#uninstalling-a-pack).

## Sample issues

The install adds four issues so the views are not empty:

- **Triage me: set a priority, then move me out of Triage**, in Triage.
- **Drag me to In Progress**, in To Do and assigned to the person who installed. It is what My issues shows
  them.
- **Open me and put me in a project**, in In Progress.
- **Review me, then move me to Done**, in In Review.

The last three are what the Active board shows.

## Dev Tracker and Dev Project OS

Dev Project OS is unchanged by this pack, and installing Dev Tracker does not touch an installed Dev Project
OS. The two use the same database names (Issues, Sprints and Releases) in a space with the same name
(Product), so they cannot be installed into the same space:

- **Previewing** Dev Tracker in a space that holds Dev Project OS lists Issues, Sprints and Releases as
  collisions, and changes nothing.
- **Installing** it without answering those collisions is refused, and nothing is changed.
- **Choosing Reuse for them does not get round it.** The install is refused whole with a 422 and
  "Nothing was installed". The refusal is tied to Dev Project OS's Releases Status being a workflow field.
  Dev Project OS stays exactly as it was.

An install matches databases by name only within the space it installs into. A same-named database in
another space is not a conflict, so [installing Dev Tracker into a different
space](/mcp/tools/#databases-with-the-same-name-in-other-spaces) is not blocked by Dev Project OS being
somewhere else.

## Installing and uninstalling

- **Installing again** into the same space creates nothing new, and Active stays the one default view.
- **Uninstalling** removes the automations. It does not delete the four databases or the issues in them.
  See [Uninstalling a pack](/mcp/tools/#uninstalling-a-pack).
