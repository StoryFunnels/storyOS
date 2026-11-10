---
title: "Settings: Workspace"
description: Rename the workspace, see and resend expired invitations, and manage installed packs from Settings.
sidebar:
  order: 2
---

The **Workspace** group is for admins: **General**, **Members**, **Plan & billing** (StoryOS Cloud
only) and **Packs**. See [Settings](/settings/overview/) for who sees what.

## Rename the workspace

**Settings → General** has a **Workspace name** field above the description. Edit it and press
**Save** (or Enter in the name field). The name is shown in the sidebar, the workspace switcher and
the Settings pages. Rules the page applies: the name is trimmed, it cannot be empty ("A workspace
needs a name."), and it can be up to 100 characters; a longer one shows how many characters are over
and Save stays off. The description sits under it and saves with the same button. Only an admin can
change either; for anyone else the fields are read-only.

The **Client portal branding** (logo and accent colour) is under **Advanced** on the same page, with
its own Save.

## Invitations: expired ones are labelled, and can be sent again

On **Settings → Members**, the **Invitations** box lists every invitation nobody has accepted. Each
row says what state it is in:

- **Pending**, with the date it expires.
- **Expired**, with the date it expired. Its link no longer works.

Expired invitations are listed first, and the box heading counts them ("4 expired · none pending").
Every row has a **Send again** button; on an expired invitation it is the main action. Sending again
issues a new link and a new seven days, and the old link stops working. After a send, the same
invitation cannot be sent again for a minute: a second attempt inside that minute tells you to wait.
The minute is counted from the last send, so an invitation that expired weeks ago is not held back.

## Packs

**Settings → Packs** lists the packs installed in the workspace: name, version, when it was installed
and by whom, and **Up to date** or **Update available**. When an update is waiting, **Update to
v{version}** opens the same install dialog used from the gallery, in update mode. **Browse packs**
goes to the gallery at `/w/{workspace}/packs`, where you choose and install a pack. With nothing
installed the page says so and explains what a pack is.

Under **Advanced** there is an **Uninstall** row for each pack, and it asks first. Uninstalling
removes the views, automations, agents and skills the pack added, except any you changed since. The
databases, fields and records stay. See [writing a pack manifest](/guides/pack-manifest/) for what a
pack contains.

## Plan & billing

Offered only on StoryOS Cloud: a self-managed instance does not show it. It was called **Billing**
before, at the same address.
