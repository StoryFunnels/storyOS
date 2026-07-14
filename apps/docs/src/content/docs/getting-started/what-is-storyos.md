---
title: What is StoryOS
description: StoryOS is an open-source, API-first work OS — connected databases you can run an entire company on, with AI agents as a first-class client.
sidebar:
  order: 1
---

StoryOS is a **connected-database work OS**: open source, self-hostable, and API-first.
You define databases, connect them with real relations, and look at the same records
through tables, kanban boards, calendars, galleries, lists, feeds, and timelines. Nothing
is paywalled — the self-hosted core is fully capable, free forever.

The web UI is just the first client of a public REST API. Everything it does, a script —
or an AI agent, via [MCP](/mcp/overview/) — can do too.

## The engine

- **Databases & fields** — text, rich text, number, checkbox, date, select, multi-select,
  URL, email, person, relation, lookup, rollup, formula, button. Schema changes are runtime
  API calls, not migrations.
- **Relations** — first-class and paired on both sides (a Project sees its Tasks, a Task sees
  its Project), one-to-many or many-to-many, across spaces. [Learn more →](/concepts/relations/)
- **Lookups & rollups** — surface a related record's field, or aggregate related records
  (count / sum / avg / min / max). [Learn more →](/concepts/lookups-and-rollups/)
- **Formulas** — `{Allocation} - {Days Used}`, `days_between(today(), {Due})`, 19 functions,
  5-level chains. [Learn more →](/concepts/formulas/)
- **Views** — table (virtualized, inline editing, batch edits), kanban with drag-and-drop, and
  calendar with drag-to-reschedule. Saved filters and sorts per view. [Learn more →](/concepts/views/)
- **Entity pages** — every record is a page: fields, rich-text description, attachments,
  comments with @mentions, and a full activity trail.

## Working in it

- **Templates** — installable packs (client work, sales CRM, content pipeline, social calendar,
  meetings, org chart, time off, dev project…), each with sample data and a built-in guide.
- **Automations & buttons** — trigger on record changes or a schedule; buttons run actions with
  one click. [Learn more →](/concepts/automations/)
- **Command palette** — search, navigation, and recents. Inbox and My Work views for
  notifications and assignments.
- **Guests & granular access** — invite a client into exactly one space with viewer →
  commenter → editor → creator grants. Everything else is invisible to them.
  [Learn more →](/concepts/access-and-roles/)
- **CSV import** — with type inference, relation matching by title, and a dry run.

## API-first

- Versioned REST API under `/api/v1`, OpenAPI spec generated from code, interactive docs at
  `/api/docs` on your instance.
- Personal access tokens, rate limiting, and a query endpoint with a filter AST — everything
  needed to build an MCP server or any other client. [API reference →](/api/overview/)

## The agentic layer

Most "AI in a work tool" is a chat box bolted on the side. StoryOS is the opposite: the
workspace **is** the agent's operating environment. Your databases are its long-term memory
and its hands; the [MCP server](/mcp/overview/) is the read/write substrate. An agent reads the
schema, queries state, creates and updates records, links them, presses buttons, comments for
humans, and leaves an audit trail — it doesn't "integrate with" StoryOS, it runs your work
inside it.

## Principles

1. **Relations are the core primitive.** A database without relations is a spreadsheet.
2. **API-first, no exceptions.** The UI consumes the same public API everyone else gets.
3. **Capability is never paywalled.** The self-hosted core is fully capable, free forever.
   Monetization is managed hosting and AI on top — never crippling the engine.
4. **Structure over documents.** The unit of work is a record in a database, not a page in a tree.
5. **Schema is data.** Databases, fields, relations, and views are API resources with stable IDs.
6. **Boring, predictable, self-hostable.** Runs a 10-person agency on a small VPS.

## Next steps

- [Self-host StoryOS](/self-hosting/overview/) in one command.
- Skim the [core concepts](/getting-started/concepts/).
- [Connect an AI agent](/mcp/overview/) to your workspace.
