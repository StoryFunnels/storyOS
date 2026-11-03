---
title: The Team Wiki pack
description: What the built-in Team Wiki pack creates, the three views it ships, the four starter pages, and the two rules that move a stale page to Needs review and tell its owner.
sidebar:
  order: 12
---

**Team Wiki** is a built-in Business Pack for a team whose answers live in chat, or whose documents
nobody can say are still true. Every page has an owner and a review date. Its slug is `team-wiki`. It
installs into a space named **Wiki** unless you
[choose another space](/mcp/tools/#installing-a-pack-into-an-existing-space). It needs no connection and no AI.

## What it creates

Two databases:

| Database | Fields |
|---|---|
| **Pages** | **Owner** (a person), **Last reviewed** (a date), **Status** (Draft, Verified, Needs review), **Team** (a link to Teams), **Parent page** (a link to another page) and **Sub-pages** (the pages whose Parent page is this one) |
| **Teams** | **Pages** (the pages the team keeps). It has no other fields |

Each Status option carries a category: Draft is unstarted, Verified is completed, Needs review is
started. See [Option categories](/guides/pack-manifest/#option-categories).

## The three views

All three are on Pages.

- **All pages**, a list grouped by Team. It is the view Pages opens on.
- **My pages**, a list of the pages whose Owner is the person looking at it. It is one shared view: each
  teammate sees their own pages in it.
- **Needs review**, a table of pages whose **Last reviewed** date is more than 90 days ago. It looks only
  at that date, not at Status, so an old **Draft** shows up in it too. A page with **no** review date does
  not. The 90 days are counted back from today each time the view is opened (in UTC), so the view stays true
  as the days pass.

## Two rules keep the review date honest

The pack installs two automations on Pages, both switched on.

- **Move stale pages to Needs review** runs every day at 09:00, by the server's clock. It selects the
  pages whose Status is **Verified** and whose Last reviewed is more than 90 days ago, and sets their
  Status to **Needs review**. It leaves a **Draft** alone however old it is, and a **Verified** page with
  no review date alone too. A scheduled rule works through at most 500 matching pages per run.
- **Review reminder** runs when a page's Status changes to **Needs review**, and sends the page's Owner
  the notification "A page you own is 90 days old and needs another look."

The reminder fires on the change into Needs review, by the daily rule or by a person. It does not fire
for a page that is created already in Needs review, for a change to any other Status, or for an edit to
another field. Because a page leaves the daily rule's selection the moment it moves, the owner is told once
for that move, not every day the page stays stale. The wording says 90 days even when a person moved the
page by hand.

Nothing sets **Last reviewed** for you. The review is a person's: when you have checked a page and it is
still right, set it to **Verified** and set **Last reviewed** to today.

## The four starter pages

The install adds one team, **Everyone**, and four pages on it. Each page is a record in Pages, and its
text is the record's body. All four start as **Draft**, owned by the person who installed the pack, with
**Last reviewed** empty.

- **Home**: how to find and add a page, and what the three statuses mean. The other three pages have Home as
  their Parent page.
- **Onboarding**: a first-week plan for a new starter.
- **How we work**: meetings, decisions and where work lives.
- **Tools & accounts**: a table of tools, who gives access, and a warning not to put a password, API key
  or shared login on any page.

Text in [square brackets] is a placeholder your team replaces. The pages are a starting point: change
anything that does not fit, then mark the page Verified. Home says search finds a page by its title.

## Installing and uninstalling

- **Installing again** into the same space creates nothing new, and does not add a second copy of a page's
  text.
- **Uninstalling** removes the two automations. It does not delete the Pages or Teams databases, the
  pages or their text. See [Uninstalling a pack](/mcp/tools/#uninstalling-a-pack).
- **Installing into a database that already exists** leaves that database's own default view as it is.
  See [Views](/guides/pack-manifest/#views-and-the-one-a-database-opens-on).
