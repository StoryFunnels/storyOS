---
title: Core concepts
description: The StoryOS mental model in five minutes — workspaces, spaces, databases, fields, relations, views, and records.
sidebar:
  order: 3
---

StoryOS models your business as **connected databases**. A handful of primitives compose into
everything else.

## The hierarchy

- **Workspace** — the tenant boundary. Holds spaces, members, and API tokens.
- **Space** — a named group of databases, and the unit of guest access and template installs.
  Every database belongs to exactly one space.
- **Database** — a user-defined type (*Tasks*, *Clients*, *Articles*). Owns fields, records, and
  views. Creating one is an API call, not a migration.
- **Field** — a column definition with a `type` and type-specific config. Every database has one
  built-in title field. [Details →](/concepts/databases-and-fields/)
- **Record** — a row, and also a full page: fields, a rich-text description, attachments,
  comments, and an activity trail.
- **View** — a saved way of looking at a database's records (table, board, calendar…) with its own
  filters and sorts. [Details →](/concepts/views/)

## The core primitive: relations

A database without relations is a spreadsheet. In StoryOS, [relations](/concepts/relations/) are
first-class and **paired on both sides** by construction — link Projects and Tasks once, and each
Project sees its Tasks while each Task sees its Project. Relations can be one-to-many or
many-to-many, and can cross spaces.

On top of relations you get:

- **[Lookups & rollups](/concepts/lookups-and-rollups/)** — pull a related record's field in, or
  aggregate related records (count / sum / avg / min / max).
- **[Formulas](/concepts/formulas/)** — compute values from other fields, including lookups and
  rollups.

## Making it move

- **[Views](/concepts/views/)** turn one dataset into tables, boards, and calendars.
- **[Automations & buttons](/concepts/automations/)** run actions on a trigger or a click.
- **[Access & roles](/concepts/access-and-roles/)** scope what members and guests can see and do.

## It's all an API

Every one of these is an API resource with a stable ID. That's what makes templates, the
[REST API](/api/overview/), and the [MCP server](/mcp/overview/) possible — schema is just data.
For the full canonical model, see the [data model reference](/concepts/data-model/).
