---
title: The Deal Desk pack
description: What the built-in Deal Desk pack creates, how it links to Agency OS, its eight views, its sample data, the seven automations (two install off), and its three agents, which ask before changing anything and wake only when you switch them on.
sidebar:
  order: 14
---

**Deal Desk** is a built-in Business Pack for a business that sells services to other businesses and wants every
deal, quote and hand-off to delivery in one place. Its slug is `deal-desk`. It installs into a space named
**Sales** unless you [choose another space](/mcp/tools/#installing-a-pack-into-an-existing-space). It builds on
**Agency OS** and declares that it needs your own AI, for its agents.

## What it creates

Eight databases of its own:

| Database | Fields |
|---|---|
| **Accounts** | **Status** (Prospect, Working, Customer, Disqualified), **Owner** (a person), **Industry** (SaaS, E-commerce, Publishing, Coaching, Local business, Other), **Website** |
| **Contacts** | **Role**, **Email**, **Phone** (text), **Buying role** (Decision maker, Champion, Influencer, Blocker) |
| **Deals** | **Stage**, **Amount** (USD, no decimals), **Close date**, **Owner**, **Next step**, **Next step date**, **Source** (Referral, Website, Outbound, Event, Other), **Lost reason** (Price, Timing, Went with a competitor, No decision, Not a fit), and **Last activity** (see below) |
| **Activities** | **Status** (Planned, Logged), **Type** (Call, Meeting, Email, Note), **Date** (with a time), **Notes** |
| **Quotes** | **Status** (Draft, Sent, Accepted, Declined, Expired), **Valid until**, and **Total** (see below). The record's own page is the proposal text. |
| **Quote Lines** | **Qty**, **Unit price** (USD), **Discount %**, **Line total** (a formula) and **List price** (see below) |
| **Products** | **Price** (USD), **Billing** (One-off, Monthly, Hourly), **Active** (a checkbox) |
| **Competitors** | **Website**, **Where they beat us**, and **Deals lost to them** (see below) |

A deal's **Stage** has seven options, each with a category: **Lead** is backlog, **Qualified** is unstarted,
**Discovery**, **Proposal** and **Negotiation** are started, **Won** is completed and **Lost** is canceled. Quote
**Status** categories are Draft unstarted, Sent started, Accepted completed, and Declined and Expired canceled.
See [Option categories](/guides/pack-manifest/#option-categories).

### Money and the computed fields

- **Line total** is a currency formula, `Qty * Unit price * (1 - Discount % / 100)`, and a missing discount
  counts as 0.
- **Total** on a quote is a rollup that sums its lines' Line total.
- **Unit price** is a typed number, not a lookup, so you can quote a price that differs from the product's. **List
  price** is a lookup of the linked product's Price, shown beside it to compare.
- **Last activity** on a deal is the date of its latest activity whose Status is in the completed category, so a
  Planned activity does not count.
- **Deals lost to them** on a competitor counts its linked deals whose Stage is in the canceled category.

### The links

Eleven links, each created with a field on both ends: Contacts to Accounts, Deals to Accounts, Activities to Deals,
Deals to Contacts (many to many), Quotes to Deals, Quote Lines to Quotes, Quote Lines to Products, Deals to
Competitors (many to many), Activities to Contacts, and the two into Agency OS below.

## How it links to Agency OS

The manifest declares that it builds on the `agency-os` pack through `requires.packs`, naming three Agency OS
databases: **Clients**, **Contacts** and **Projects**. Two links reach into it: each account's **Client** field
links to a client (the client gains **Sales accounts**), and each project's **Source deal** field links back to
the deal it came from (the deal gains **Projects**).

What the install does depends on whether Agency OS is installed in the workspace:

- **Installed:** its Clients, Contacts and Projects are linked, not copied. No second Clients or Projects is made, and
  Clients and Projects gain only the link field. Agency OS's Contacts is preselected for reuse in the preview, so you
  get one Contacts database that gains **Buying role** and the links; the review's own picker for a database lets
  you decline it.
- **Not installed:** you choose `also_install` (install Agency OS first, then link) or `create_here`. With
  `create_here`, the default, Deal Desk makes its own **Clients** and **Projects** in its space, each a title and
  its link field, and its own Contacts.
- **Declining the link** with `create_here` while Agency OS is installed makes Deal Desk's own databases instead,
  so there are then two Contacts.

You pass the choice as `required_packs`, for example `{"agency-os": "also_install"}`, to the preview and the
install; the install result reports each required pack as `linked`, `installed_and_linked` or `created_here`.
The web install dialog's code on main does not reference `required_packs`, so this page does not describe a
web control for it.

## The eight views

- **Pipeline** on Deals, a board grouped by Stage with Amount, Owner and Close date on each card. Won and Lost
  columns are hidden, so a deal moved there leaves the board. It is the view Deals opens on.
- **My open deals** on Deals, a table of deals whose Owner is the person looking at it and whose Stage is not in
  the completed or canceled category.
- **Closing this month** on Deals, a table of open deals whose Close date is this month, soonest first.
- **Why we lose** on Deals, a board of canceled-category deals grouped by Lost reason.
- **Quote board** on Quotes, a board grouped by Status. It is Quotes' default view.
- **Price list** on Products, a table of products whose Active box is checked. It is Products' default view.
- **Accounts** on Accounts, a table grouped by Status. It is Accounts' default view.
- **This week** on Activities, a calendar on Date. It is Activities' default view.

## Sample data

The install adds 28 sample records, each titled with "(sample)": 4 products, 2 competitors, 3 accounts, 4 contacts,
5 deals, 2 quotes, 4 quote lines and 4 activities. Each deal's title says the move it teaches, for example **Drag
me to Qualified (sample)** (a Lead), **My next step is overdue: set a new one (sample)** and **Open my quote and
mark it Accepted (sample)** (in Proposal, with a Sent quote). There is also a Won deal and a Lost deal with a
reason. One logged call carries notes, the kind of thing Call Debrief summarises.

## The seven automations

Five of the pack's rules install switched on:

- **Stalled deal nudge** runs on weekdays at 09:00. For each open deal whose Next step date is before today, it
  notifies the deal's owner that the next step is overdue.
- **Lost needs a reason** runs when a deal's Stage changes. If the deal is in the canceled category and Lost reason
  is empty, it notifies the owner.
- **Expire old quotes** runs daily at 06:00 and sets a quote to **Expired** when its Status is in the started
  category (Sent) and Valid until is before today. A Draft, or a Sent quote still in date, is left alone.
- **Accepted quote moves the deal to Won** runs when a quote's Status changes to a completed-category state. It
  proposes setting the linked deal's Stage to Won and asks for approval first (`require_approval`).
- **Stalled deals digest** runs on Mondays at 09:00 over open deals, sorted by when each was last updated, oldest
  first, limited to 5. It notifies each of those deals' owners.

Two install **off**:

- **Won: tell Slack** posts "Deal won: {Name} ({Amount}). Time to hand it off." when a deal reaches the completed
  category. It sets no channel, so it uses the workspace's default Slack channel. It acts outside the workspace.
- **Monday pipeline review** runs Deal Coach on open deals on Mondays at 08:00. It runs an agent.

### Why those two are off, and switching them on

A rule that acts outward (email, Slack, a webhook) or runs an agent installs switched off whatever the pack says,
so installing a pack never starts one by itself. The preview and the install result list each automation with
whether it is enabled, and for an off one why: `switched_off_because` is `outward` for the Slack rule and `agent`
for the Monday review. A person switches one on in either of two ways:

- In the web install review, with the switch under the rule.
- Over the API or MCP, by naming its label, "Database.Rule name", in `enable_automations` on the install, for
  example `Deals.Won: tell Slack`. Only name one when the person asked for it. See
  [MCP tools](/mcp/tools/).

## The three agents

Each agent is owned by the person who installed the pack, uses **Your own AI** (its AI mode, which StoryOS does
not meter; see [Writing a pack manifest](/guides/pack-manifest/#agents-ai-mode-and-skills)), has read and write
scope, and answers as a comment on the deal.

| Agent | What it does | Wakes when |
|---|---|---|
| **Deal Coach** | Reads a deal, its account, contacts, activities and quotes, says what is missing before it can close, and suggests one next step. Its instructions say never to contact anyone. | A deal's Stage becomes **Proposal** |
| **Call Debrief** | For a Call or Meeting activity that has Notes, writes a debrief on the deal: what was agreed, objections, and the next step with a date. | An activity's Status becomes **Logged** |
| **Hand-off Writer** | For a won deal, proposes a Project in Agency OS with Client and Source deal set, and writes the hand-off on the deal: what was sold and promised, and who the contacts are. | A deal's Stage becomes **Won** |

- **They ask before changing anything.** Each agent has a [write
  gate](/concepts/approval-gates/#gating-an-agents-record-writes) on creates and updates with no database
  named, so those writes are held for approval in the Inbox rather than applied. Their approval policy also
  covers delete, email, webhook and outward actions.
- **Call Debrief wakes on every logged activity.** A trigger cannot filter by Type, so the agent's instructions
  tell it to do nothing unless the activity is a Call or Meeting with Notes. That is an instruction to the AI,
  not a platform filter.
- **Their triggers install off.** All three triggers install switched off (`switched_off_because` is
  `wakes_agent`) and none is human-gated. Switch one on in the install review under **Wake it automatically**,
  or with `enable_agent_triggers`, using the label the preview shows, for example `Deal Coach ← Deals.Stage =
  Proposal`. Until then nothing wakes them, and you can still start a run yourself, for example with the MCP
  `run_agent` tool.

## Installing and uninstalling

- **Installing again** into the same space creates nothing new.
- **Uninstalling** removes the pack's views, automations and agents, not its databases or records. See
  [Uninstalling a pack](/mcp/tools/#uninstalling-a-pack).
