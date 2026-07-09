---
id: MN-065
title: GitHub integration v1 — token import + refresh, auto-link by branch/reference
status: done
depends_on: []
size: L
---

Fibery syncs Repository/Branch/Issue/PR/Member one-way; linking PRs to work items is manual. Founder: "you can do this one significantly better."

## Where we beat them (v1 scope)
1. **Import lands in a working tracker** — issues arrive as task-DNA records (states/labels/assignee mapped), not a read-only mirror.
2. **Auto-linking**: PR branch names / titles containing a record reference (e.g. `mn-123`, `#123`) link the PR to that record automatically via a relation.
3. **Self-hosted**: the token stays on your server.

## Design
- Settings → Integrations → GitHub: PAT (classic or fine-grained, `repo` read) stored server-side (workspace settings, encrypted-at-rest deferred — documented), repo list `owner/name`.
- `POST /workspaces/:ws/integrations/github/sync`: fetches issues + PRs (REST, paginated, since-cursor stored) into a **GitHub pack** (Repositories 📦, Issues 🐛 with state/labels/assignee-login/url, Pull Requests 🔀 with state/branch/author/url, one_to_many Repo→both). Upsert by github id (stored in a hidden field? v1: `GitHub ID` number field + match-on-import). Manual "Sync now" button + auto-resync on schedule via MN-047 machinery (schedule trigger calling sync = v1.1; v1 manual).
- Auto-link pass: PRs whose branch or title matches `[a-z]{2,5}-\d+` or `#<n>` referencing an imported Issue's number → relation link.
- Webhooks/two-way = v2 (needs public endpoint; self-host docs).

## Acceptance criteria
- [ ] Token + repos config per workspace (admin); sync endpoint imports/updates Issues + PRs idempotently (upsert by GitHub id)
- [ ] Branch/title reference auto-linking PR↔Issue proven by test (mocked GitHub API)
- [ ] GitHub pack databases with sensible views (Open PRs, My issues by login mapping note)
- [ ] Guide: setup, token scopes, what syncs, self-host note
