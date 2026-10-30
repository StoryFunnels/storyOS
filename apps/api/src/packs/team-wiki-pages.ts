import { optionRef, sampleRef, SAMPLE_ME } from '@storyos/schemas';

/**
 * The four starter pages' text: Dara's, approved on ticket #1147, word for word, with these edits from the ticket:
 *   - Home, Finding things: search finds a page by its TITLE (page bodies are not searched, so the pack does not promise it).
 *   - Home, What the status means: the "nobody has checked it for 90 days" line, because the daily rule really does flip a Verified page
 *     older than 90 days to Needs review (see team-wiki.ts), so the Status itself changes.
 * [Brackets] are the text a team replaces. Each page teaches one habit: Home the Status, Onboarding the Owner, How we work the Team,
 * Tools & accounts the Last reviewed.
 */
export const HOME_BODY = `This is your team's wiki: the pages that say how things work here. If a question gets asked twice, the answer belongs on a page.

**Finding things**
- Open **All pages** to see every page, grouped by the team that keeps it.
- Search (⌘K, or Ctrl+K on Windows) finds a page by its title.
- Every page names its owner. If something looks wrong, ask them.

**Adding a page**
1. In All pages, press **New**.
2. Title it with the question people ask. "How do we book time off?" works better than "Time off".
3. Set yourself as **Owner** and pick its **Team**.
4. Leave it as **Draft** until someone else has read it.

**What the status means**
- **Draft**: still being written. Useful, but check before you rely on it.
- **Verified**: the owner checked it, and it's true today.
- **Needs review**: someone thinks it's out of date, or nobody has checked it for 90 days. Say why in a comment.

When you check a page and it's still right, set it to **Verified** and set **Last reviewed** to today. That's the whole system.

This page is a starting point. Change anything that doesn't fit your team, then mark it Verified.`;

export const ONBOARDING_BODY = `Welcome. This is the plan for your first week. [Name] owns this page and keeps it up to date. If anything here is wrong or missing, tell them, so the next person doesn't run into it too.

**Day 1**
- Get your accounts working. Tools & accounts lists every tool and who gives access.
- Meet [your manager] and [your buddy for the week].
- Read How we work.

**Days 2–3**
- [Sit in on a ___ with ___.]
- Pick one small, real piece of work and finish it.

**Days 4–5**
- [Your first piece of work that someone else will use.]
- Write down three things that confused you. Add them here, or send them to this page's owner.

**Who to ask**

| For | Ask |
|---|---|
| Accounts and access | [name] |
| Your work this week | [name] |
| Anything else | [name] |

**Why every page has an owner:** one named person keeps each page true. When you find a mistake, you don't have to fix it yourself. Tell the owner. Once you know a topic well, you can own its page.`;

export const HOW_WE_WORK_BODY = `How [team name] runs its week: the meetings, how decisions get made, and where work lives.

**Meetings**

| Meeting | When | Who | What it's for |
|---|---|---|---|
| Planning | [Mon 10:00, 30 min] | [Everyone] | Agree what we do this week |
| Check-in | [daily, 15 min] | [Everyone] | Say what's stuck |
| Retro | [every 2 weeks] | [Everyone] | One thing to keep, one to change |

If a meeting can't fill in "What it's for", cancel it.

**Decisions**
- Small and easy to undo: whoever is doing the work decides, and tells the team.
- Big or hard to undo: write it down first, give people [2 days] to object, then decide.
- Write down who decided and why. A decision with no name gets argued again.

**Where work lives**
- Tasks: [where your team tracks tasks]
- Documents and how-tos: this wiki
- Chat: [your chat tool], for quick questions. Anything someone will need next month goes on a page.

**Every page belongs to a team.** The **Team** field says who keeps a page, and All pages groups pages by it. This wiki starts with one team, Everyone. Add your real teams in Teams. A team that works differently can have its own How we work page, linked to that team.`;

export const TOOLS_BODY = `Every tool the team uses, what it's for, and who gives access. Fill in the table and delete rows you don't need.

| Tool | What we use it for | Ask for access | Plan / cost |
|---|---|---|---|
| StoryOS | Tasks, documents, this wiki | [name] | [plan] |
| [Email] | | [name] | |
| [Chat] | | [name] | |
| [Calendar] | | [name] | |
| [Password manager] | Shared logins | [name] | |

**Never put a password, API key or shared login on this page, or any page.** Keep them in the password manager and say here who can share them.

**Keeping this true:** tools change quietly. A price goes up, someone leaves, access moves. Whenever you check this table, set **Last reviewed** to today, even if nothing changed. A page that goes 90 days without a review shows up in **Needs review**, and its owner gets a reminder.`;

/** A starter page: a Draft (a template is not yet true for this team), owned by whoever installed the pack, no review date, on the Everyone team. */
export const starterPage = (title: string, description: string, parent?: string) => ({
  database: 'Pages',
  values: {
    name: title,
    status: optionRef('Pages', 'Status', 'Draft'),
    owner: SAMPLE_ME,
    team: [sampleRef('Teams', 'Everyone')],
    ...(parent ? { parent_page: [sampleRef('Pages', parent)] } : {}),
  },
  description,
});
