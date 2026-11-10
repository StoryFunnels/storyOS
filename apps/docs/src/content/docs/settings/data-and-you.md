---
title: "Settings: Data & security, and You"
description: Export, Trash and the Audit log; your Profile, Preferences and Notifications; and where the power controls sit under Advanced.
sidebar:
  order: 5
---

Two groups of the [Settings menu](/settings/overview/): **Data & security** (admins) and **You**
(everyone).

## Data & security

On the Settings home this is one card, **Data & security**, that opens Export. Its three pages are
in the menu.

**Export.** **Settings → Export** downloads the whole workspace as one `.zip`: every space,
database, record, document and the access settings. Personal spaces are never included. The zip holds
`manifest.json`, one JSON file per database (schema and records), the relation graph, and the
attachment files. A large workspace streams, so the download can take a moment to start. A non-admin
who opens the page is told that only admins can export the whole workspace. See
[workspaces, spaces and databases](/concepts/workspaces-spaces-databases/) for what an export holds.

**Trash.** **Settings → Trash** lists deleted **spaces** and **databases**, each with a **Restore**
button. They stay restorable for 30 days.

**Audit log.** **Settings → Audit log** shows who did what, people and agents, across the workspace,
with **Load more** at the bottom. The filters are under **Advanced**: an actor, a type,
a record or object ID, and a From and To date (typed as `2026-10-27`, `jul 15` or `yesterday`). See
[record history](/concepts/record-history/) for what the log records.

## You

**Profile.** **Settings → Profile** (the address is still `/account`) holds your photo (PNG, JPG or
WebP, up to 1 MB), your name, and your password. Removing your photo asks first. Under **Advanced**,
**Sessions and account** lists your other signed-in devices, which you can sign out, and **Delete my
account**.

**Preferences.** **Settings → Preferences** is for you only, on this browser: **Theme**, **Date
format**, **Time format** and **Week starts on**.

**Notifications.** **Settings → Notifications** has a switch for each kind of event that reaches your
Inbox, all on by default: **Assigned to me**, **Mentions**, **Comments** (on records you watch),
**Status changes** (a status or priority change on a record you are assigned to) and **Record
changes** (any field on records you watch). An admin also sees a note that GitHub review
notifications are a workspace setting, on **Integrations → GitHub**. See
[mentions and notifications](/concepts/mentions-and-notifications/).

**Referrals.** Offered on StoryOS Cloud only. A self-managed instance does not show it.

## What "Advanced" means

Several Settings pages keep the controls that are used rarely, or that undo something, in an expandable
**Advanced** section under the main content: client portal branding on General, Uninstall on Packs,
the filters on the Audit log, and sessions and account deletion on Profile.
