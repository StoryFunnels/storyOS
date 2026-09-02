---
title: Sync with Google Calendar
description: Two-way sync between a date-bearing database and a Google Calendar — connect, map fields, and how all-day events round-trip.
sidebar:
  order: 5
---

**Settings → Integrations → Google Calendar.** Connects a database to a calendar so records and
events stay in sync in whichever direction you choose.

## Connect

Google Calendar uses its **own connection**, separate from the one YouTube uses — reconnecting or
revoking Calendar never changes an unrelated Google connection's permissions.

## Create a binding

A binding links one database to one calendar:

1. **Pick a database**, or create one from a **Calendar template** right there in the picker —
   it builds a database with `Start`, `End` and `Description` fields already in place and maps
   them for you, rather than leaving you to map three fields by hand afterwards.
2. **Pick the calendar** to sync with.
3. **Map fields**: a **Start** field (required), an **End** field (optional — an event with no
   mapped end gets a default 1-hour duration), and a **Description** field (optional).
4. **Choose a direction**:

| Direction | What moves |
|---|---|
| **StoryOS → Google** | Records create/update/delete events. Google is never written back. |
| **Google → StoryOS** | Events create/update/delete records. StoryOS is never written back. |
| **Two-way** | Either side can originate a change; the other follows. |

Pull and two-way bindings poll Google every five minutes, and whenever you press **Sync**.

Database and space names that repeat elsewhere are disambiguated in the picker — you always see
which space a same-named database lives in before you choose it.

## All-day events

Whether an event is **all-day** is decided by the mapped **Start** field's type: a plain date
field (no time) syncs as an all-day event; a date-*and*-time field syncs as a timed one.

**Google's all-day end date is exclusive; a StoryOS date range is inclusive.** A one-day event
stored as `2026-03-05` in StoryOS becomes a Google event ending `2026-03-06` — that's the same day
represented two different ways, not an off-by-one bug. The sync converts between the two on every
write, in both directions.

## If a binding stalls

Each binding shows its **last error** inline the moment a sync fails — an invalid mapped date, a
revoked connection, a deleted calendar — rather than failing silently. **Remove** deletes the
binding without touching anything it already synced in either direction.
