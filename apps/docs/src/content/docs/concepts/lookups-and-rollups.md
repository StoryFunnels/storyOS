---
title: Lookups & rollups
description: Surface a related record's field, or aggregate related records with count / sum / avg / min / max.
sidebar:
  order: 3
---

Lookups and rollups are derived fields that read **through a [relation](/concepts/relations/)**.
They keep computed context next to your records without duplicating data.

## Lookups

A **lookup** surfaces a field from a related record. On *Projects* related to *Clients*, add a
lookup **Account Owner** that pulls the Client's *Owner* — now it shows on every Project and in
Project views, always current.

Add one in one click from a relation field: choose the relation, then the field to surface.

## Rollups

A **rollup** aggregates the related records on the other side of a relation:

| Aggregation | Example |
|---|---|
| `count` | Open Tasks per Project |
| `sum` | Total Days across a Team Member's Time Off |
| `avg` | Average deal size per Client |
| `min` / `max` | Earliest due date, largest invoice |

A `count` rollup needs no target field; the rest aggregate a chosen number (or date) field on the
related records.

## Feeding formulas

Both lookups and rollups are ordinary fields that [formulas](/concepts/formulas/) can reference.
The classic vacation-balance recipe:

1. On **Team Members**, add a rollup **Days Used** = *sum* of `Days` through the Time Off relation.
2. Add a formula **Balance** = `{Allocation} - {Days Used}`.

Other favorites: event budget vs actual (`{Budget} - {Spent}` where *Spent* is a sum-rollup over
Expenses), and pipeline value per client (a sum-rollup over Opportunity `Amount`).

:::note[Traversal]
Formulas work over one database at a time — there's no `{Client.Owner}` traversal. Use a **lookup**
to bring a related field in, then reference the lookup; use a **rollup** to aggregate, then
reference the rollup.
:::
