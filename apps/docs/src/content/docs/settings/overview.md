---
title: Settings
description: Where Settings lives, what the home page shows, the five groups of pages, who can open each, and where the old settings URLs now lead.
sidebar:
  order: 1
---

Everything that configures StoryOS for you or for your workspace is under **Settings**. It is one
click away: the **gear** in the rail on the left opens Settings directly. (The gear used to open a
small menu with Settings as the second click.)

Below the gear, the account menu (your avatar) holds **Profile**, **Preferences**, **Keyboard
shortcuts** and **Sign out**.

## The home page

`/w/{workspace}/settings` is the Settings home. It shows the workspace name and your role ("you are
an admin"), then one card for each area **you** can open. A card says what needs you, from figures
the server reported:

- **Members**: how many people, and whether invitations are waiting or have expired.
- **Connect your AI**: how many AI apps work and how many need reconnecting.
- **API tokens**: how many tokens, and when one was last used.
- **Integrations**: how many connections work and how many need attention.
- **Packs**: what is installed and whether an update is available.
- **Data & security**: opens Export, with Trash and Audit log beside it.
- **You**: your name, with Profile, Preferences and Notifications.

A number is shown only when the server has answered. While it has not, or if the request fails, the
card has no count rather than a zero. A card that needs you has its detail line in the warning colour.

## The five groups

While you are in Settings, the sidebar swaps the space tree for the Settings menu. It has **Back to
{workspace}** at the top (it returns to the last page you were on outside Settings, or the workspace
home if there is none), **Settings** for the home page, and five groups:

| Group | Pages | Who can open it |
|---|---|---|
| **You** | Profile, Preferences, Notifications, Referrals | Everyone. Referrals is offered only where the referral programme is on (StoryOS Cloud). |
| **Workspace** | General, Members, Plan & billing, Packs | Admins. Plan & billing is offered only where billing is on (StoryOS Cloud). |
| **AI** | Connect your AI, Runners, Agent rules | Connect your AI and Runners: admins and members. Agent rules: admins. |
| **Connections** | Integrations, API tokens, Webhooks | API tokens: admins and members. Integrations and Webhooks: admins. |
| **Data & security** | Export, Trash, Audit log | Admins. |

So a **guest** sees only the You group, a **member** sees You plus Connect your AI, Runners and API
tokens, and an **admin** sees everything. A group with nothing in it for you is not shown. An
admin-only page opened by a member (from an old link, say) says in the page that it is for workspace
admins. Some entries carry a small count at the right: **expired** invitations on Members, **to fix**
on Connect your AI, the number of connections on Integrations, installed packs on Packs, and tokens
on API tokens. Like the home cards, a count appears only when the server reported a real figure.

Each group has its own page here:

- [Workspace](/settings/workspace/): rename the workspace, expired invitations, Packs.
- [AI](/settings/ai/): reconnect an AI app, Agent rules.
- [Connections](/settings/connections/): one card per provider, API tokens, Webhooks.
- [Data & security, and You](/settings/data-and-you/): Export, Trash, Audit log, Profile, Preferences, Notifications.

## Old settings URLs

The settings addresses that worked before the restructure still resolve. These are the ones that
moved, read from the redirects in the web app. `{ws}` is your workspace id.

| Old URL (under `/w/{ws}/settings`) | Now |
|---|---|
| `/settings` | The Settings home page (it was not a page before). |
| `/integrations/mcp` | `/connect-ai`. Redirected for everyone, including members, who cannot open Integrations. |
| `/governance` | `/agent-rules`. Governance became Agent rules. |
| `/connections` | The page of the provider it was about, or the Integrations hub. See below. |

`/connections` is no longer a page of its own: every credential now lives on its provider's page (see
[Connections](/settings/connections/)). The old address still works because the sign-in return from a
provider, buttons in the app and older links point at it. It carries `?connected=`, `?error=`, `?add=`
and `?name=` along, so the "connected" message and a pre-named connect form still appear:

- `?connected=google` goes to the YouTube page, `?connected=google-calendar` to Google Calendar,
  `?connected=linkedin` to LinkedIn.
- `?add=shopify&name=...` opens the connect form on the Shopify page with the name filled in; `?add=http`
  goes to Custom API.
- An error, or a provider this version does not know, goes to the Integrations hub, which shows the
  message.
- With no query it goes to the Integrations hub.

Pages that keep their address but changed what they are called: `/account` is **Profile**, `/api` is
**API tokens**, `/billing` is **Plan & billing**. Pages that are new: `/agent-rules`, `/packs` (the
list of installed packs; the pack gallery you choose from is still at `/w/{ws}/packs`), and under
Integrations the pages `/integrations/email`, `/integrations/custom-api`, `/integrations/apify` and
`/integrations/openai`. Every other settings address (`/general`, `/members`, `/connect-ai`,
`/runners`, `/webhooks`, `/export`, `/trash`, `/audit-log`, `/notifications`, `/preferences`,
`/referrals`, and each `/integrations/{provider}`) is unchanged.
