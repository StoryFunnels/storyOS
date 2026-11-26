---
title: "Settings: Workspace"
description: Rename the workspace, see and resend expired invitations, see what an invited person sees, and manage installed packs from Settings.
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

## Delete a workspace

There is no delete button, and no API call for it. This is deliberate. To delete a workspace, contact support.

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

## What the person you invite sees

An invitation email links to a **Join** screen, not to the general sign-in page. The screen shows the
workspace's name and logo and, when the person who sent the invitation has a name, says "*Name*
invited you to *Workspace*". The invited email address is shown and cannot be edited, because the
invitation was sent to that address.

- **No account yet.** The person enters their name and a password and presses **Join *Workspace***.
  They end up in the workspace they were invited to. Signing up from an invitation never creates a
  workspace of their own, and the create-a-workspace step does not open while the invitation is still
  usable.
- **An account already exists for that email.** The screen asks for that account's password instead
  of a new one, with a **Forgot password** link; after the reset the person signs in again on the Join screen.
- **Already signed in as the invited address.** One button, **Join *Workspace***. If that account never
  verified its email address, joining is refused until it does: the screen offers **Send verification
  email**, and once the person has opened the link in it, the same invitation works. An account created
  from the invitation itself is verified already, so it joins straight away.
- **Signed in as a different address.** The screen says the invitation was sent to the invited
  address and that the person is signed in as another, and offers **Switch account**. It signs them
  out and shows the Join screen again so they can continue as the invited address. It does not join
  the workspace under the wrong account.

If the link cannot be used, the screen says so instead of the form:

| The link is | The screen says |
|---|---|
| Expired | "This invite has expired." and to ask the person who invited you (by name, when known) for a new link. |
| Already used | "This invite was already used." with the same request. |
| Revoked | "This invite was revoked." and "Ask *Name* for a new link." (or "Ask whoever invited you for a new link." when no name is known). |
| Unknown | "This invite link no longer works. Ask whoever invited you for a new link." It names no one. |

The expired, used and revoked screens show the workspace name and a single button: **Sign in**, or
**Go to my workspaces** when the person is already signed in. A revoked link shows this screen for 30 days after the revoke; after that it reads like a link that never existed. A link that never existed looks the same
as one that was replaced by a newer invitation, on purpose, so nobody can use the screen to find out
which links exist. Send the person a new invitation, or use **Send again** on one that expired.

If the screen cannot reach StoryOS at all, it says it could not check the invite and to
reload, which is different from a dead link. If the request fails while someone is joining from the
form, the button comes back and the screen says "Could not join the workspace. Try again."

For developers: `GET /api/v1/public/invites/details?token=…` needs no sign-in and returns only the
inviter's name, the workspace name and logo, the invited email and a `status` of `valid`, `expired`,
`used`, `revoked` or `not_found`. For `not_found` every other field is null. It is limited to 20 requests a
minute per client address. `POST /api/v1/workspaces` with an `invite_token` accepts the invitation
and creates no workspace; a token that cannot be accepted is refused and creates nothing. To have a new account
verified at creation, send the invitation's token as `invite_token` in the body of `POST /api/v1/auth/sign-up/email`;
it counts only when it names a pending invitation for exactly the address being signed up, and anything else
leaves the account unverified with the same response as any sign-up. Accepting with an unverified address is a
`403` `invite_email_unverified` (see [API conventions](/api/conventions/#joining-by-invite-link)); the
verification email is sent by `POST /api/v1/auth/send-verification-email` with `{ "email", "callbackURL" }` while signed in.

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
