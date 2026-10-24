# Analytics: event naming, the `surface` property, and the current events

PostHog runs across three surfaces — the product (`app`), the marketing site (`site`, a separate
repo) and these docs (`docs`). This page is the rule for adding an event and the list of what exists
today. The list is maintained by hand: when you add or remove an event, change it here in the same PR.

## The rule for a new event

- **snake_case, `<object>_<past-tense verb>`** — `workspace_created`, `invite_sent`,
  `mcp_setup_check_failed`. It says something *happened*, not something you want to happen.
- **No surface prefix in the name.** `docs_page_rated` is the only exception, kept because it was
  named before the `surface` property existed; a new event is not `app_…` or `site_…`.
- **The surface is a property, not part of the name.** `surface` is `app`, `site` or `docs`.
  - **app** — stamped on every event in PostHog's `before_send` (`apps/web/src/lib/funnel.ts`,
    `withSurface`), *not* registered once. A registered property is wiped by `posthog.reset()`,
    which runs on every identity change, so later events silently lost it (found in ticket #818). A
    caller's own `surface` wins.
  - **docs** — `posthog.register({ surface: 'docs' })` in `apps/docs/astro.config.mjs`.
- **Campaign attribution is `utm_source` / `utm_medium` / `utm_campaign`**, carried on links that go
  to the app. Docs adds them to its three kinds of app link (`nav`, `footer`, `inline` as the
  medium; the page path as the campaign) and never overwrites an author's own `utm_*`
  (`apps/docs/src/scripts/analytics-behaviour.js`). The app keeps the **first touch** across the
  sign-up flow (`FIRST_TOUCH_KEYS`: the three utm params and `ref`; first touch wins) and stamps it
  on `user_signed_up` as `first_touch_utm_source` etc.
- **Site and docs stay cookieless.** They run with `persistence: 'memory'`, so there is no
  identifier to carry from page to page and **no identifier may ride on a link**. Events there carry
  only a path, a search query and a count.
- **Off unless configured.** Docs ships none of this unless `PUBLIC_POSTHOG_KEY` is set; the API
  emits nothing unless `POSTHOG_PROJECT_TOKEN` is set, so self-hosted installs send nothing.
- **The docs key is a BUILD-time value (ticket #820).** `apps/docs/astro.config.mjs` reads
  `PUBLIC_POSTHOG_KEY` with its own `readEnvFile()` while the config is evaluated, because Astro
  does not expose `.env` to the config. So on Cloudflare it must be a **build variable** of
  `Workers Builds: storyos-docs`, not a runtime binding, and a change takes effect only on a
  rebuild. A runtime variable (or a missing one) ships the site with **no analytics at all and no
  error**; that is how docs went to zero after #946.
  - **Check it from the served HTML first.** `curl -s https://docs.storyos.dev/ | grep -c posthog`
    is non-zero with the key set (an inline script in `<head>`) and **zero** without it. It does not
    depend on a script having run. In a browser, `window.posthog` follows the same rule: the inline
    snippet assigns a stub to it before `posthog.init` runs (the real client replaces the stub once
    `array.js` loads), so it is defined when the key is baked in and undefined when it is not.
  - Docs has no `/ingest` proxy (that belongs to `apps/web`). Events go straight to the configured
    PostHog host (`https://us.i.posthog.com` unless `PUBLIC_POSTHOG_HOST` says otherwise), so look
    for requests there, not to `/ingest`.

## Current events

Client events (`posthog.capture` in the web app):

| Event | Emitted from |
|---|---|
| `user_signed_up`, `user_logged_in` | `(auth)/signup`, `(auth)/login`, and `lib/funnel.ts` for the Google return (`method: google`, marker stripped from the URL so a reload doesn't re-fire) |
| `invite_sent` · `invite_accepted` | `settings/members`, `invite` |
| `workspace_created` | `new-workspace` |
| `onboarding_pack_installed` · `template_installed` | `new-workspace`, `template-gallery` |
| `csv_import_completed` · `share_access_granted` | `import-wizard`, `access/manage-access-dialog` |
| `integration_disconnected` | `settings/integrations` |
| `mcp_endpoint_copied` | `settings/integrations` |
| `mcp_setup_started` · `mcp_setup_client_selected` | `settings/connect-ai` |
| `mcp_setup_check_started` · `_succeeded` · `_failed` | `settings/connect-ai` |
| `plan_upgrade_clicked` · `trial_started` | `settings/billing` |

Server events (`AnalyticsService.capture`, attributed to the workspace's founding admin, each with a
deterministic event uuid so a retried send collapses to one event):

| Event | Emitted from |
|---|---|
| `workspace_activated` | `workspaces/workspace-activation-events.service.ts` — exactly once per workspace, by a periodic sweep of the same live state the Getting Started checklist reads, so every way of creating records counts (an MCP client or agent included). |
| `subscription_started` | `billing/billing.service.ts` — once per workspace, with `plan`, `seats`, `converted_from_trial`. |

Docs events (`apps/docs/src/scripts/analytics-behaviour.js`): `docs_search_performed`
(`query`, `result_count`) and `docs_page_rated` (`helpful`, `path`).

The marketing site's events live in the `storyos-website` repository, not here.
