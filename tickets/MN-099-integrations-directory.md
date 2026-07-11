---
id: MN-099
title: Integrations directory — platform catalog + per-platform setup pages
status: done
depends_on: []
size: M
---

## Problem

The Integrations page crammed every provider's full setup form onto one page. That
doesn't scale: today it's API keys, tomorrow OAuth / Slack / Google Calendar, plus
native StoryFunnels & StoryPages. We need a **directory** — platforms with logos +
short descriptions — where setup lives on each platform's own page.

## Done

- `settings/integrations` is now a **catalog grid**: one card per platform (icon,
  name, one-line description, status badge — Connected / Set up → / Coming soon).
  Available platforms link to their own route; "soon" ones are non-clickable.
- Extracted **`integrations/github`** and **`integrations/linear`** as standalone
  setup pages (back-link to the directory). The directory reflects connection state.
- Seeded "coming soon" cards for **Slack, Google Calendar, StoryFunnels, StoryPages**
  so the roadmap is visible and each just needs its own page + backend when built.

## Follow-ups
- OAuth flow scaffold (redirect + callback + token store) for the first OAuth provider.
- Backend + setup page for Slack / Google Calendar; native StoryFunnels/StoryPages.
