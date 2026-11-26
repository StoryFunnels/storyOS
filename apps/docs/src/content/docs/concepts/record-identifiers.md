---
title: Record identifiers
description: Give a database a prefix such as ISSUE and every record answers to ISSUE-5201, in the app, over the API and over MCP. The identifier is worked out from the prefix and the record's number, never stored.
sidebar:
  order: 21
---

Every record in a database has a **number**, counted up from 1 in that database. A database can also
carry an **identifier prefix**. With the prefix `ISSUE`, record 5201 is called **ISSUE-5201**: the
prefix, a dash, the number. People say it in a chat, write it in a commit, and paste it into a
search; it opens the record.

A database with no prefix behaves exactly as before. Nothing changes for it, and its records read
`#17`.

## Set a prefix

A workspace **admin** sets it on the database: its settings, or the API
`PATCH /workspaces/{ws}/databases/{db}` with `identifier_prefix`. Send `null` to remove it.

- 2 to 10 characters, capital letters and digits, starting with a letter. `ISSUE`, `SF`, `ENG2`.
  Anything else is refused with a 422.
- **Unique in the workspace**, ignoring case. A prefix another database already uses is refused with a
  409 that names that database. Another workspace may use the same prefix.
- Not on a system database (such as Members).
- **Only a person who is an admin can set it.** An agent, even one acting for an admin, and a token
  bound to specific databases are refused, the same as a member. A prefix names every record of the
  database, so it is a decision people make.
- A database in the trash keeps its prefix, so restoring it never collides.

Changing or removing the prefix changes every identifier at once, because nothing was stored. Old
links by record number and by id keep working.

## Where the identifier shows

- **In the app**, the record's header shows `ISSUE-5201` where it showed `#5201`, and so does the
  Details panel.
- **In the API**, every record payload (get, list, query, create, update) carries `identifier`:
  `"ISSUE-5201"`, or `null` when the database has no prefix. The database payloads carry
  `identifierPrefix`.
- **Over MCP**, records carry `identifier`, `list_databases` and `describe_database` show the
  `identifier_prefix`, and `update_database` sets it (admin only).

## Open a record by identifier

- **In the app:** `/w/{workspace}/i/ISSUE-5201` redirects to the record. If there is nothing to open
  it shows the not-found page.
- **API:** `GET /workspaces/{ws}/records/by-identifier/ISSUE-5201`. The prefix is case-insensitive.
  The answer is the record, plus the `database_id` it lives in.
- **MCP:** `get_record` with `identifier: "ISSUE-5201"` and the workspace. No database is needed.

The lookup uses the same access check as every other record route, and it does not tell you what you
may not know. A prefix that does not exist, a database you cannot see (restricted, or outside a guest's
grants), a number that does not exist, and a record in the trash all give the **same 404**. A token
bound to specific databases gets its usual boundary refusal for all of them. So the lookup cannot be
used to find out which prefixes the workspace has.

## Numbers, and records that came from another tool

New records take the next number as always. An **import** that already knows each record's number
(an issue that was 5201 in the tool it came from) can write the record at exactly that number.

- This is for imports only. It is not available on the create route: a client choosing numbers would
  collide with everyone else. The number in a normal create request is ignored.
- A number that is already taken is refused, naming the record that has it. An import never
  overwrites a record's number, and a record in the trash still holds its number. An identifier is
  never reused.
- After an import, new records continue after the **highest** number written, so ISSUE-5202 follows
  ISSUE-5201 and nothing collides. Gaps in the numbers are fine.

History an import writes is labelled with its own source, **import**, in the change log and the audit
log, not as an automation: the log says an import did it, with the time and the person the other tool
recorded.
