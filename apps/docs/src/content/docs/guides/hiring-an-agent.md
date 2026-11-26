---
title: Hiring an agent
description: The Agents list under AI, and the one-screen Hire an agent card — name, job, what wakes the agent, where it works, what it asks about first and which Runner it runs on — and what the card tells you if a step fails after the agent is hired.
sidebar:
  order: 12
---

**AI › Agents** lists the agents in your workspace, and **Hire an agent** at the top opens one card
where you set the whole agent up. This page covers both. To get a computer ready to run the agent,
see [Adding and removing a Runner](/guides/adding-and-removing-a-runner/).

## The Agents list

One row per agent, with:

- **Agent**: its name and the first lines of its job.
- **Runs on**: the Runner it is assigned to. An agent that does not use a Runner says what it uses
  instead (**StoryOS AI** or **Without an AI**), and a switched-off one says **Switched off**. One
  that needs a Runner and has none says **No Runner yet**. A guest sees **A Runner** rather than
  the machine's name.
- **Status**: the Runner's state, or **Waiting for a Runner**.
- **Last run**: the time of its latest run, as a clock time for today, a date earlier this year and
  a date with the year before that. A run that is not simply done carries its state underneath
  (Failed, Running, Needs approval, Waiting for limit, Waiting for hours, Waiting for reserve, Budget reached). It
  says **Never** only when StoryOS knows the agent has no run record. When it cannot read the run
  history, or cannot tell when the agent last ran, it shows a dash instead of guessing.
- **Manager**: the agent's owner. A person who has since left the workspace is still named, marked
  **(left)**.

On a narrow screen the list keeps only the agent and where it runs; the rest is on the agent's page.
Opening a row opens that agent. Below the list, **Open the Agents database** shows every agent's
definition as a table.

Members and admins see the **Hire an agent** button. Guests do not, and the server refuses a
guest's hire.

## The Hire an agent card

Everything is on one screen. The card opens filled in with an example you edit in place, not blanks:
a name, a job, a weekday-morning schedule and every "Asks before" box ticked.

1. **Name.** Required; **Hire** stays off until it has one.
2. **Its job.** What the agent is for, in your own words. It is saved as the agent's goal.
3. **Wakes when.** Zero or more rules for when the agent runs by itself. With none, the card says
   **Only when you start it.** The kinds:
   - **On a schedule**: every 10, 15 or 30 minutes, every hour, every day, every weekday (Monday to
     Friday) or every week on a day you pick. Day, weekday and week rules take a time of day in
     half-hour steps. Minute and hour rules can be limited to **only 9:00–18:00**.
   - **When a field changes**: pick a database from **Works in** and a field in it. Only fields a
     person edits are offered, not formulas, rollups, lookups, relations, AI fields or buttons.
   - **When a new record is added**: pick a database from **Works in**.
   - **When you assign it a record**: pick the database where you assign it a record. This needs a
     relation field on that database that points at the Agents database. It is offered to
     workspace admins only.

   For a schedule the card shows how often it will run, for example "About 54 runs a day. Each run
   uses some of your Claude limit." Times are read in your browser's time zone, which the card
   names (for example Europe/Madrid (UTC+1)), so "09:00" is your 09:00 and not the server's.
4. **Works in.** The databases the agent works in. Search and add them; a field or new-record rule
   can only watch a database listed here, and removing a database moves or drops the rules that
   watched it. The databases you list are also where the agent can work: its access is limited to
   exactly those, never another database in the same space or in another space. The picker lists databases only: it cannot add a whole space. An agent can work in a
   whole space, but you set that after hiring, in the **Target spaces** field on the agent's record; see
   [Where an agent works](/guides/runner/#where-an-agent-works-databases-and-whole-spaces). A whole space
   covers its user databases only, never a system database such as Members, which an agent reaches only when you put its id in **Target databases**; a name never binds one. A schedule does not need one: with none chosen it is
   kept on the Agents database.
5. **Asks before.** Four boxes, all ticked to begin with, so an agent starts careful and you untick
   what you trust it to do alone:
   - **Sending an email**
   - **Anything that leaves the workspace**: this holds outward actions and calls to another service.
   - **Changing a record**: holds the agent's record creates and updates for approval, on any
     database. This box is shown to workspace admins only; for a member the card says that holding
     changes to records for approval is set by a workspace admin.
   - **Deleting anything**

   Held actions wait for a person's decision; see [approval gates](/concepts/approval-gates/).
6. **Reports to you.** You become the agent's manager. The agent's page shows all of this later; its
   wake rules are changed per database, in **Automations**.
7. **Runs on.** One of your own Runners. You can hire without one: the card says the agent starts
   work once it has a Runner, and the card offers a way to add one.

An agent hired here uses your own AI (through a Runner) and is switched on from the start.

On the agent's page you can later start it on records that were already in its trigger state before
it existed, switch a **Non-AI** agent to your own AI, and press **Run now**. See
[Starting an agent on records already waiting](/guides/runner/#starting-an-agent-on-records-already-waiting)
and [Switching an agent to your own AI, and Run now](/guides/runner/#switching-an-agent-to-your-own-ai-and-run-now).

### When something cannot be hired

- If the card is incomplete, a line above the buttons says what to fix and **Hire** stays off: a
  missing name, a wake rule that has no database or field chosen yet, or a schedule the server
  would refuse. If the workspace's Agents database has no option for one of the ticked "Asks before"
  boxes, Hire is switched off rather than creating an agent that asks less than the boxes say.
- If the agent record itself is refused, nothing is created and you are told so.
- Once the agent exists, each remaining step (the changes gate, each wake rule, the Runner) is
  applied on its own. If one fails, the agent is still hired, and a warning names every setting that
  did not apply and why, and says everything else was saved. Set those on the agent's page. You land
  on that page after hiring either way.

## What the agent's page says

For a workspace admin the facts box on an agent's page has two rows beside the manager and the Runner:

- **Wakes when.** One line per trigger the agent has, in words: *A client's Status becomes Onboarding*,
  *A client is assigned to it*. A trigger that is switched off carries **Off**. One that waits for a
  person carries **Starts only when you do**. With no trigger the row says **No trigger of its own.**
  A line under it says wake rules are set per database, in **Automations**, with a link to the
  database of its first trigger; the row does not list automations, so it never claims nothing else
  wakes the agent.
- **Works in.** The spaces and databases the agent is allowed to work in. A whole space is listed
  with a note that it covers user databases only. It never lists a system database such as Members.
  With none chosen it says **No database chosen.**

A member or guest does not see these two rows. **Agent runs** and **Triggers** are no longer rows in
the sidebar; the page has a line linking to the same records as tables.
