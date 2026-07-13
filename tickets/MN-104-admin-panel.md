---
id: MN-104
title: Superadmin panel — operate the hosted StoryOS instance
status: todo
depends_on: [MN-069, MN-105, MN-107]
size: L
---

## Why

Running a shared multi-workspace cloud instance needs an **instance-level admin**
(distinct from a workspace admin). Today there's no way to see who's on the box, how
big things are, or to support/suspend a customer. This is the operator's cockpit.

## Two scopes (don't conflate)
- **Superadmin** (us, the instance operator) — cross-workspace, gated by a
  `platform_admin` flag on the user + a separate `/admin` surface, never exposed to
  tenants.
- **Workspace admin** (already exists via roles) — settings, members, access grants.

## What belongs in the superadmin panel (thought through)

1. **Overview / usage dashboard** — signups over time, active workspaces (DAU/WAU/MAU),
   total records / documents / storage, API + MCP call volume, error rate, email
   deliverability. The health of the business at a glance.
2. **Users** — search, view, disable/ban, force-verify, **impersonate** (time-boxed,
   audit-logged — the #1 support tool), delete/GDPR export.
3. **Workspaces** — list with size (records, storage, members), owner, plan, created,
   last-active; suspend / restore / hard-delete; view (read-only) for support.
4. **Billing & plans** (ties to MN-107) — plan per workspace, trial/dunning status,
   MRR/ARR, manual overrides/comps, refunds link-out.
5. **Mechanics / ops** — feature flags, per-plan limits & rate limits, storage-driver
   status, background-job/queue health, migration status, maintenance mode, broadcast
   banner / announcements.
6. **Moderation** (once public forms/sharing exist, MN-101) — flagged public content,
   abuse reports, kill-switch a public link.
7. **Growth** — waitlist / invite gating, referral view, cohort retention.
8. **Audit log** — every superadmin action (who impersonated whom, who suspended what).

## Design notes
- `platform_admin` boolean on users (seeded via env for the first operator).
- `/admin` app section behind a hard guard; server enforces on every admin endpoint.
- Read-heavy; start with Overview + Users + Workspaces + impersonation + audit log,
  layer billing/mechanics as those systems land.

## Acceptance criteria
- [ ] `/admin` reachable only by platform admins; all admin endpoints server-guarded.
- [ ] Overview metrics; Users (search + disable + impersonate); Workspaces (size + suspend).
- [ ] Every admin action is audit-logged; impersonation is time-boxed + visibly flagged.
