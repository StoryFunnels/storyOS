---
title: Changelog
description: What changed in StoryOS, week by week, newest first, with a link to the page that explains each change.
---

What changed in StoryOS, week by week, newest first. Each line links to the docs page that explains
the change, and each docs change that documents a shipped change adds its line here. The date is the
day the change reached the product.

## Week of 9 November 2026

- **26 Nov** — Every automation action now checks its rule owner's access each time it runs, not only when the rule is saved. If the owner left, was demoted or lost the database, the action is refused with a message naming the person (never a record title), and rules whose owner is gone are flagged **owner missing**. [Who a rule runs for](/concepts/automations/#who-a-rule-runs-for-and-where-it-may-write)
- **26 Nov** — An automation rule can **Attach a PDF**: it makes a PDF of the record, or of the one record it links to, using the rule owner's access checked on every run, and attaches it to a file field. Without a PDF renderer the rule cannot be switched on. [Attaching a PDF](/concepts/automations/#attaching-a-pdf)
- **25 Nov** — An agent's **Target databases** entry binds a user database by name only when exactly one database carries it (the agent's own target spaces first); a system database such as Members needs its id, and an ambiguous name shows as unresolved. [How a database name is read](/guides/runner/#where-an-agent-works-databases-and-whole-spaces)
- **25 Nov** — An agent trigger can carry a condition, so a record that does not match wakes nothing and the skip is listed; the Lead Follow-up pack uses it for Do Not Contact. [Trigger conditions](/concepts/agent-runs/#trigger-conditions)
- **25 Nov** — An agent can no longer change an existing agent's Target databases or scopes, as it already could not change Target spaces, Tools, Model or budget. [Where an agent works](/guides/runner/#where-an-agent-works-databases-and-whole-spaces)
- **25 Nov** — An admin no longer sees or restores a member's deleted personal space in Settings → Trash. [Deleting a database, view or space](/concepts/workspaces-spaces-databases/#deleting-a-database-view-or-space)
- **25 Nov** — A guest who asks the API for a personal access token is refused with a 403, matching the app. [Authentication](/api/authentication/)
- **25 Nov** — The API container runs as the `node` user and fixes the ownership of an older attachments volume on first start. [Attachments](/self-hosting/attachments/)
- **25 Nov** — Settings shows **N connected** beside **Runners**, in the warning colour when a Runner is offline or at its limit. [See your Runners](/guides/adding-and-removing-a-runner/#see-your-runners)
- **25 Nov** — The catch-up confirmation names the first five waiting records, and the agent's **Runs** list shows each waiting record as a **Not started** row. [Starting an agent on records already waiting](/guides/runner/#starting-an-agent-on-records-already-waiting)
- **25 Nov** — The delete-field confirmation counts a relation by its links, says nothing is lost for a formula, lookup or rollup, and says "at least" when some records are hidden from you. [Field lifecycle](/concepts/databases-and-fields/#field-lifecycle)
- **25 Nov** — A built-in Shop OS pack: customers, products, orders and order lines, an order board by status, an Unpaid Orders view, and a drafter agent that installs switched off. [The Shop OS pack](/guides/shop-os-pack/)
- **15 Nov** — The record page's Activity, Comments and About sit under the fields on a window narrower than 900px, Activity reads as "set", "cleared" and "changed" sentences, and a half-typed comment is kept per record. [The record page](/concepts/databases-and-fields/#the-record-page)
- **15 Nov** — My Work gathers finished rows under a closed **Done · N** group, writes the space on two databases that share a name, and says **Not recorded** when it has no record of who assigned you. [My Work: what is waiting on you](/concepts/mentions-and-notifications/#my-work-what-is-waiting-on-you)
- **13 Nov** — An approval that an automation rule asked for names the rule, in the approvals list and in My Work, and the API carries `rule_id`, `rule_name` and `rule_label`. [How the Inbox names a rule's request](/concepts/approval-gates/#how-the-inbox-names-a-rules-request)
- **15 Nov** — Display holds the **Columns** list with **Show all** and **Hide all**, row height reads **Compact**, **Default** or **Tall**, and the title column is always on. [Hiding columns](/concepts/views/#hiding-columns)
- **15 Nov** — Home always shows **Review** (approvals waiting), shows **Automation runs** once there is an agent, and opens with a greeting and today's date. [The workspace home](/concepts/workspaces-spaces-databases/#the-workspace-home)
- **13 Nov** — **New space**, **From template** and **New group** are in one **+** menu beside **Spaces**; agent runs, triggers and Members leave the sidebar tree. [The rail and the panel](/concepts/organising-the-sidebar/#the-rail-and-the-panel)
- **13 Nov** — An agent's page says what wakes it and where it works, for admins. [What the agent's page says](/guides/hiring-an-agent/#what-the-agents-page-says)
- **15 Nov** — A provider the server operator must set up says **Set up by the server operator**, and API tokens and Webhooks keep their how-to text in a closed section at the bottom. [Settings: Connections](/settings/connections/)
- **23 Nov** — A new record starts at the first option of a state field when that field is a select whose every option has a state category, as the built-in packs declare theirs, so a pack's tasks, pages, deals, leads and issues no longer start with an empty State or Status. [Default values](/concepts/databases-and-fields/#default-values)
- **23 Nov** — Adding a card, a row or a record from a view makes a record with no title and puts the cursor in it, instead of saving the word "Untitled" as the title. [The record page](/concepts/databases-and-fields/#the-record-page)
- **11 Nov** — **New** on a database gets an arrow that lists its record templates; choosing one makes the record from it, a record's menu has **Save as template**, and **Manage templates...** renames or deletes them. [Record templates](/concepts/databases-and-fields/#record-templates)
- **16 Nov** — A long field name wraps in full on the record page, and where it is still shortened, in table headers, menus and pickers, pointing at it shows the whole name. [The record page](/concepts/databases-and-fields/#the-record-page)
- **13 Nov** — Every `records/:rec/...` API route takes a record's public number as well as its uuid, looked up inside the database in the path. [API conventions](/api/conventions/#resource-layout)
- **13 Nov** — The self-hosting quickstart sets `CONNECTIONS_MASTER_KEY` and defaults `API_URL` and `WEB_URL` to `http://localhost`, so first sign-up works on port 80. [Self-hosting overview](/self-hosting/overview/#quickstart)
- **15 Nov** — `get_field_usage` counts relation fields by their links instead of reporting 0, and says when the count is incomplete for you. [MCP tools](/mcp/tools/)
- **16 Nov** — A rollup filter on linked records no longer breaks listing the database; a filter the database cannot run is refused when you save the rollup. [A rollup filter is checked when you save it](/concepts/lookups-and-rollups/#a-rollup-filter-is-checked-when-you-save-it)
- **23 Nov** — A personal access token bound to a space opens that space's user databases only. A system database such as Members is covered only when the token's `database_ids` lists it. [Binding a token to specific spaces or databases](/api/authentication/#binding-a-token-to-specific-spaces-or-databases)
- **18 Nov** — The Runners list says how many of your Runners are connected, offline and at their limit, from one definition of connected. [Adding and removing a Runner](/guides/adding-and-removing-a-runner/#see-your-runners)
- **12 Nov** — The wake queue and its counts say `limited` when some wakes are left out because you cannot read their records, so an empty list is not read as nothing having started the agent. [Where a wake stands](/concepts/agent-runs/#where-a-wake-stands)
- **15 Nov** — The audit log names the person and says what happened in words, with the record's number, title and database; its filters sit under **Filter**, and each row can copy its record ID. [Data & security, and You](/settings/data-and-you/)
- **15 Nov** — Agent rules leads with **Recent agent actions**, in the audit log's words, and keeps the read-only enforcement view in a closed **How agent rules are enforced** section. [AI](/settings/ai/)
- **11 Nov** — The MCP tool list is lighter for clients that cap tools: long grammars moved out of tool descriptions into `get_started` sections, and maintainer tools are only on the internal profile. [MCP tools](/mcp/tools/#how-an-agent-reads-it)
- **13 Nov** — The gold mark on a record, `last_ai_change_at`, now means an agent or an MCP connection changed it. An automation or a person in the web app no longer sets it, and old values were recomputed. [When an AI last changed a record](/api/conventions/#when-an-ai-last-changed-a-record)
- **11 Nov** — A pack install onto a database you adopted stops with a message naming the field when a relation's name is taken by a field of another type, the preview warns first, and installing again after an uninstall works. [A relation whose field name is already taken](/mcp/tools/#a-relation-whose-field-name-is-already-taken)
- **12 Nov** — A pack agent follows its skills by link, so renaming a skill no longer breaks the agent or a pack update. [Skills follow the skill, not its name](/guides/pack-manifest/#skills-follow-the-skill-not-its-name)
- **16 Nov** — A schedule trigger on the automation canvas names its interval, weekday or weekdays, active window and time zone, instead of "Every undefined". [Editing a rule's actions on a canvas](/concepts/automations/#editing-a-rules-actions-on-a-canvas)
- **15 Nov** — A revoked invite link opens a "This invite was revoked" screen that says who to ask for a new link, for 30 days after the revoke. [Settings: Workspace](/settings/workspace/#what-the-person-you-invite-sees)
- **11 Nov** — Dry-run a formula before saving it, over the API and MCP: it returns the result type and sample values, or errors with the position and the nearest valid name. [Formulas](/concepts/formulas/#check-a-formula-before-you-save-it)
- **10 Nov** — A run held by an agent's monthly budget is named in the web app instead of showing as something else. [The StoryOS Runner](/guides/runner/#budgets)
- **15 Nov** — An invitation link opens a Join screen that shows who invited you and to which workspace, and joining never creates a new workspace. [Settings: Workspace](/settings/workspace/)
- **15 Nov** — The API reference documents reading an invite link, joining with `invite_token` on workspace create, and the refusal codes. [Joining by invite link](/api/conventions/#joining-by-invite-link)
- **10 Nov** — The install review has a **Wake it automatically** switch for a pack agent's trigger, and each database row names its fields. [Agent triggers install switched off](/guides/pack-manifest/#agent-triggers-install-switched-off)
- **10 Nov** — Signup opens on **What are you working on?** with Team Board, Dev Tracker and Team Wiki first. [Creating a workspace](/guides/creating-a-workspace/)
- **10 Nov** — An install that reuses another pack's databases reports them as linked, not created here. [Packs that build on other packs](/guides/pack-manifest/#packs-that-build-on-other-packs)
- **10 Nov** — A connected provider page leads with its card, and GitHub lists untracked repositories with a Track button. [Connecting GitHub](/guides/github/)
- **10 Nov** — Notifications says which events also arrive by email and to which address, Email me my work is a setting there, the Inbox offers it once, and every email opens with a Quill header and fits a phone screen. [Mentions and notifications](/concepts/mentions-and-notifications/#what-goes-by-email-and-where-it-arrives)
- **13 Nov** — An agent given a whole space reaches that space's user databases only, never a system database such as Members. [Where an agent works](/guides/runner/#where-an-agent-works-databases-and-whole-spaces)
- **12 Nov** — Deleting one record moves it to Trash and offers Undo for 10 seconds, in the table and in the record panel. [Workspaces, spaces and databases](/concepts/workspaces-spaces-databases/#deleting-a-database-view-or-space)
- **10 Nov** — Settings has a home page and five groups, and the old settings addresses lead to the new pages. [Settings](/settings/overview/)
- **10 Nov** — My Work lists what is waiting on you, and you can have it emailed as a digest at a time you choose. [Mentions and notifications](/concepts/mentions-and-notifications/)
- **10 Nov** — A guest is always free, whatever access they hold. [Access and roles](/concepts/access-and-roles/)
- **10 Nov** — Hire an agent: set up a whole agent on one card under AI › Agents. [Hiring an agent](/guides/hiring-an-agent/)
- **10 Nov** — The Deal Desk pack has its own guide. [The Deal Desk pack](/guides/deal-desk-pack/)
- **10 Nov** — A Runner can be limited to working hours and can keep a share of the tool's usage limit in reserve. [Agent runs](/concepts/agent-runs/)

## Week of 2 November 2026

- **5 Nov** — An agent's page offers one button to start it on records already waiting in its trigger state, and a Non-AI agent can be switched to your own AI from its page. [The StoryOS Runner](/guides/runner/#starting-an-agent-on-records-already-waiting)
- **4 Nov** — An agent's manager can choose its model on the agent's page, a workspace default model exists, and Runner runs start from a short StoryOS prompt. [The StoryOS Runner](/guides/runner/#which-model-it-uses)
- **4 Nov** — The Runner pairing code is shown as one block with Copy, and the Runner accepts it with or without spaces. [Adding and removing a Runner](/guides/adding-and-removing-a-runner/)
- **5 Nov** — The sidebar has a Hidden section for the spaces and databases you hid and for system spaces. [Organising the sidebar](/concepts/organising-the-sidebar/)
- **3 Nov** — A guide to the StoryOS Runner, the program that lets an agent use your own AI. [The StoryOS Runner](/guides/runner/)
- **3 Nov** — What wakes an agent on your own AI, and what its run record shows. [Agent runs](/concepts/agent-runs/)
- **3 Nov** — Guides for the Team Wiki and Dev Tracker packs. [The Team Wiki pack](/guides/team-wiki-pack/) · [The Dev Tracker pack](/guides/dev-tracker-pack/)
- **5 Nov** — A formula can be shown as currency. [Formulas](/concepts/formulas/)

## Week of 26 October 2026

- **27 Oct** — The Linear migration is a mirror you can run again, not a one-off import. [Migrate from Linear](/guides/migrate-from-linear/)
- **27 Oct** — The audit log records structural events and can be filtered by type. [Record history](/concepts/record-history/)
- **27 Oct** — The Personal section has a Personal page. [Personal space](/concepts/personal-space/)
- **28 Oct** — A list shows each record's state glyph, and clicking a column header sorts it. [Views](/concepts/views/)
- **29 Oct** — A new space opens its own page, with a card for every ready-made pack that installs into that space. [Workspaces, spaces and databases](/concepts/workspaces-spaces-databases/)
- **30 Oct** — The Team Board pack has its own guide. [The Team Board pack](/guides/team-board-pack/)

## Week of 19 October 2026

- **19 Oct** — A document can be exported as a PDF, once the optional renderer is running. [Exporting a document to PDF](/api/conventions/#exporting-a-document-to-pdf) · [PDF export](/self-hosting/pdf-export/)
- **19 Oct** — The webhook list shows each webhook's owner and why a webhook is paused. [Webhooks](/guides/webhooks/)
- **24 Oct** — An automation can run an agent on a schedule. [Automations](/concepts/automations/#running-an-agent-on-a-schedule)
- **24 Oct** — Connect your AI offers Other, for any MCP client, with a choice of OAuth or a token. [OAuth connector](/mcp/oauth/)

## Week of 12 October 2026

- **15 Oct** — A guide to running your work with an agent team. [Run your work with an agent team](/guides/agent-team/)
- **15 Oct** — A guide to connecting GitHub, including the "ignoring deliveries" notice. [Connecting GitHub](/guides/github/)
