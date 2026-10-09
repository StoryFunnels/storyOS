---
title: Skills
description: Reusable instructions your AI can run — who can see a skill, what an AI may and may not publish, and what running one really does.
sidebar:
  order: 16
---

A **skill** is a named, reusable set of instructions: what it does, when to use it, the steps, and
optionally a few worked examples. Write one when you have worked out how to do something in this
workspace that will be asked for again.

A skill is **instructions an AI will follow**, not data. That is why who can publish one is a
decision this product keeps with people (see [Skills written by AI](#skills-written-by-ai)).

## Who can see a skill

Every skill has one of four visibilities:

| Visibility | Who sees it |
| --- | --- |
| **Personal** ("Only me") | Only the person who owns it. Workspace admins can read every skill. |
| **Members** | The owner and the named people. |
| **Shared** ("Workspace") | Everyone in the workspace. |
| **Public** | Anyone with the link, signed in or not. |

A skill you write yourself is **shared with the workspace** unless you say otherwise. In the web app,
the **Skills** library in the sidebar rail is where people read, create and change skills, including
their visibility.

## Running a skill

There is no managed AI model inside StoryOS. Running a skill **resolves its instructions and
records that it ran**; it does not execute anything. **Your own AI** carries the instructions out
(through MCP, never metered), or you apply them by hand.

A skill has no identity of its own. It always runs **as the person who runs it**, capped by their
workspace role: an admin runs it with admin power, a member with write power, a guest with read
power. A teammate's AI running your shared skill never gets your access, only theirs.

## Skills written by AI

A skill an AI writes (through an API token or a connected AI such as Claude) is recorded as written
by an agent. That cannot be claimed or faked by the writer.

- **By default it stays personal.** An AI-written skill is private to the person whose
  credential wrote it, and teammates' AI will not find it. Publishing a skill is a decision about
  other people's AI, so by default an AI cannot make it.
- **A workspace admin can allow it.** In **Settings → General → Skills written by AI**, an admin can
  let AI share skills with the whole workspace. With it on, a skill an AI creates is shared with the
  workspace unless it asks for personal. Turn it off any time: new AI-written skills go back to
  personal, and skills already shared stay shared. The setting is per workspace, and **only a person
  can change it** in the web app; it cannot be changed through an API token or a connected AI, even
  one acting for an admin.
- **No setting ever lets an AI publish publicly.** Shared with the workspace is the most an AI can do,
  even with the setting on. Public links, and sharing with chosen people only, always need a person.

## Import and export

You can import a `SKILL.md` file. The import shows what was **kept** and what was **dropped**
before anything is created, and it will not invent a missing "when to use". A skill exports as
Markdown, as a Claude `SKILL.md`, or as plain text for ChatGPT custom instructions.

## Tools

Through MCP an AI can `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill`,
`run_skill`, `import_skill`, `export_skill` and `list_skill_templates`.
