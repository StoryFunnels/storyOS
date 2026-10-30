---
title: The Team Board pack
description: What the built-in Team Board pack creates, the three views it ships, who gets told when a task is assigned, and how its Open tasks count treats a new Done-like state.
sidebar:
  order: 11
---

**Team Board** is a built-in Business Pack for a team that wants one place to see who is doing what.
Its slug is `team-board`. It installs into a space named **Team** unless you
[choose another space](/mcp/tools/#installing-a-pack-into-an-existing-space).

## What it creates

Two databases:

| Database | Fields |
|---|---|
| **Tasks** | **Status** (To Do, In Progress, Done), **Assignee** (a person), **Due date**, **Labels** (Urgent, Blocked, Quick win, Idea), **Project** (a link to Projects) and **Sub-tasks** (a link to other tasks, through each task's **Parent task**) |
| **Projects** | **Owner** (a person), **Target date**, **Tasks** (every task that belongs to the project) and **Open tasks** (a count, see below) |

Each Status option carries a category: To Do is unstarted, In Progress is started, Done is completed.
See [Option categories](/guides/pack-manifest/#option-categories).

## The three views

- **Board** on Tasks, grouped by Status, with Assignee, Due date and Labels on each card. It is the view
  Tasks opens on, instead of the plain list.
- **Assigned to me** on Tasks, also a board grouped by Status, showing only the tasks whose Assignee is
  the person looking at it. It is one shared view: each teammate sees their own tasks in it.
- **All projects** on Projects, a table that shows Owner, Target date and Open tasks. It hides the
  Tasks link column, because the count says the same thing more briefly. It is not the view Projects
  opens on; Projects keeps its own **All records** list as its default.

## Open tasks counts what is not Done

**Open tasks** is a rollup on Projects that counts a project's tasks whose Status is not the **Done**
option. It names that option, not the "completed" category. So if someone adds a second finished-looking
state to Status (for example **Shipped**), tasks in it are counted as open until the rollup's filter is
edited to exclude that state too.

## Telling the assignee

The pack installs two automations on Tasks, both switched on. Each sends the new assignee the
notification "A task was assigned to you."

- **Tell the assignee** runs when a task's Assignee changes.
- **Tell the assignee of a new task** runs when a task is created, and only if its Assignee is not empty.
  A new task with no assignee tells nobody.

An automation has one trigger, which is why the job is two rules: a change of Assignee does not fire for
a task that is created already assigned.

## Sample tasks

The install adds three tasks in To Do, so the board is not empty: **Drag me to In Progress** (assigned
to the person who installed), **Open me and set a due date**, and **Assign me to someone**.

## Installing and uninstalling

- **Installing again** into the same space creates nothing new.
- **Uninstalling** removes the automations. It does not delete the Tasks or Projects databases, their
  tasks, or the default **Board** view. See [Uninstalling a pack](/mcp/tools/#uninstalling-a-pack).
- **Installing into a database that already exists** leaves that database's own default view as it is.
  See [Views](/guides/pack-manifest/#views-and-the-one-a-database-opens-on).
