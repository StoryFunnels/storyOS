---
title: Relations
description: First-class, paired-on-both-sides links between databases — one-to-many or many-to-many, across spaces.
sidebar:
  order: 2
---

Relations are the core primitive. A database without relations is a spreadsheet; with them, your
databases become a connected model of your business.

## Paired on both sides

A relation is a first-class object that ties two databases together. Creating one always creates
**two** relation-fields — one on each database — pointing at the same relation. Link *Projects*
and *Tasks* once, and:

- a **Project** record shows its **Tasks**, and
- a **Task** record shows its **Project**.

Both directions are navigable by construction — there are no orphaned one-way links.

## Cardinality

- **One-to-many** — e.g. one Project has many Tasks; each Task has one Project.
- **Many-to-many** — e.g. Articles ↔ Authors.

Self-relations (a database related to itself, e.g. Task → parent Task) and **cross-space**
relations are both allowed.

## Working with relations

- In the UI, the relation picker is first-class — pick target records by title.
- Via the API, relation values are **not** part of a record's `values`; they live in a separate
  links table and are returned as `{id, title}` chips. Set them with the links endpoints or the
  MCP `link_records` tool. See [querying records](/api/querying/).

## What relations unlock

Once two databases are related, you can:

- **[Look up](/concepts/lookups-and-rollups/)** a related record's field (surface the Client's
  owner on each Project).
- **[Roll up](/concepts/lookups-and-rollups/)** related records (sum a Client's Opportunity
  amounts, count open Tasks).
- **[Reference both](/concepts/formulas/)** in formulas (`{Budget} - {Spent}`).
