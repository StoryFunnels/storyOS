---
title: Skills
description: Reusable instructions your AI can run — who can see a skill, what an AI may and may not publish, and what running one really does.
sidebar:
  order: 16
---

A **skill** is a named, reusable set of instructions: what it does, when to use it, the steps, and
optionally a few worked examples. Write one when you have worked out how to do something in this
workspace that will be asked for again.

A skill is **instructions an AI will follow**, not data. That is why every skill an AI writes is
marked as written by an AI (see [Skills written by AI](#skills-written-by-ai)).

## Who can see a skill

Every skill has one of four visibilities:

| Visibility | Who sees it |
| --- | --- |
| **Personal** ("Only me") | Only the person who owns it. Workspace admins can read every skill. |
| **Members** | The owner and the named people. |
| **Shared** ("Workspace") | Everyone in the workspace. |
| **Public** | Anyone with the link, signed in or not. |

A skill is **shared with the workspace** unless you say otherwise, whether you or an AI wrote it. In the web app,
the **Skills** library in the sidebar rail is where people read, create and change skills, including
their visibility.

## Writing a skill that gets used

- **"When to use" is the part that matters most.** It is how a reader's AI decides to pick your
  skill without being told its name. A vague "when to use" is a skill nobody's AI will ever choose;
  say the situation, in the words someone would actually ask in.
- **Instructions are the steps**, written for an AI that has never seen your workspace. Worked
  examples are optional but make the result more reliable.
- **Publishing a skill gives the reader no access to your data.** A skill is text that runs in the
  reader's own AI, against the reader's own workspace, with the reader's own permissions. StoryOS
  stores, versions and governs it; it does not run it.
- **There is no "Run" button in the Skills library, on purpose.** A skill is instructions for an AI,
  so carrying them out is your own AI's job, not a button's.

## Running a skill

Running a skill through MCP (`run_skill`) **resolves its instructions** and returns them; it does
not call a model or execute anything. **Your own AI** carries the instructions out (through MCP,
never metered), or you apply them by hand.

**An agent can name skills.** An agent record has a **Skills** field listing skills by name. When
the agent runs, the names are looked up in the workspace's skills when the run starts, so an edit
made since the last run is what the next run uses. A run whose agent names a skill that no longer
exists fails, naming it, instead of quietly running without it.

### On a Runner, the skills' instructions are sent

An agent set to **Your own AI** runs in your own AI tool through a
[Runner](/concepts/agent-runs/#agents-on-your-own-ai). Its run is given **each attached skill's
instructions**, as a run inside StoryOS is, not just the skill names.

- **What is sent:** for each skill, its name, its "when to use" and its instructions, each in a block
  labelled with the skill's name, under "Your skills" in the run's instructions. They are treated as
  your manager's guidance for the job, and they do not override the rules the run is given.
- **When it is read:** when the Runner claims the job, by name, as the agent's owner. An edit made
  since the last run is what the next run uses.
- **Long skills are cut, and the run is told.** One skill is cut at 6,000 characters and all of an
  agent's skills together at 24,000. A skill that is cut says how many characters it has and how many
  were given, and a skill past the total is still named with that note.
- **The Run records the skill by name, not its text.**
- **A skill that cannot be sent stops the run.** If a skill the agent names was removed or renamed, or
  its owner cannot read it, the run does not start: it fails, the Run names the skill, and the agent's
  owner is notified. It does not run quietly without it.
- **A personal skill reaches a Runner only from its author, on the author's own Runner.** If the
  agent's owner is not the skill's author, or the Runner is not the author's, the skill is not sent
  and the run fails naming it. This holds for admins too: an admin can read a colleague's personal
  skill in the library, but it is never copied to another person's computer.

## Skills written by AI

A skill an AI writes (through an API token or a connected AI such as Claude) is **always recorded as
written by an AI**, and that cannot be claimed or faked by the writer. The Skills library marks it,
so anyone reading a skill can see where it came from.

- **By default it is shared with the whole workspace.** Like a skill you write yourself, an
  AI-written skill is visible to everyone in the workspace straight away, and their AI can find and
  run it. Using StoryOS through your own AI is the intended path, so there is nothing to switch on.
  An AI can also ask for a skill to stay **personal**.
- **A workspace admin can switch it off.** In **Settings → General → Skills written by AI**, an admin
  can stop AI from sharing skills with the workspace. With it off, an AI-written skill is private to
  the person whose AI wrote it, and a request to share it is refused. Skills already shared stay
  shared. The setting is per workspace, and **only a person can change it** in the web app; it cannot
  be changed through an API token or a connected AI, even one acting for an admin.
- **Skills that were already personal stay personal.** Switching anything does not widen an existing
  skill. Its owner can share it from the Skills library, or ask their AI to.
- **Making a skill public needs a person to approve it.** An AI can *ask* for a skill to be public
  (anyone with the link), but asking does not make it public. It creates an approval, the skill stays
  as it was, and the person whose AI asked gets it in the **Inbox** in the StoryOS app. The skill
  becomes public only when that person approves it there. The AI cannot approve it, even one acting
  for an admin: approvals are made by people in the app, not through an API token or a connected AI.
  If an admin has switched AI sharing off, an AI cannot ask at all. When a person makes a skill
  public themselves, in the Skills library, no approval is needed.
- **A public skill has a page a person can read.** Its link opens a plain page showing the skill's
  name, version, description, *when to use it*, instructions and examples — no sign-in, and no Run
  button, because a skill is text that does nothing on the page. The page is hidden from search
  engines and linked from nowhere. A link that has been revoked, never existed or is malformed all
  show the same "not found" page, so it never reveals which.
- **To take a public skill back, change its visibility in the Skills library.** That revokes the
  link at once. An approval can be decided only once: rejecting it after you approved does nothing
  (the app refuses it and says so), so it is never the way to undo a public skill.
- **An AI can share a skill with named people.** With visibility **Members** and a list of who, only those people (and you) can find or run it; everyone else gets nothing, not even a hint it exists. It follows the same setting as sharing with the workspace: an admin who switches AI sharing off switches this off too. An AI can add or remove a person by sending the new full list.

Because an AI can now share a skill without a person reading it first, treat the AI-written mark as
the signal: a skill with it was not typed by a person.

## Import and export

You can import a `SKILL.md` file. The import shows what was **kept** and what was **dropped**
before anything is created, and it will not invent a missing "when to use". A skill exports as
Markdown, as a Claude `SKILL.md`, or as plain text for ChatGPT custom instructions.

## Tools

Through MCP an AI can `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill`,
`run_skill`, `import_skill`, `export_skill` and `list_skill_templates`.
