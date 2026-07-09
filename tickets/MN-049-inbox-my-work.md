---
id: MN-049
title: Notifications inbox + My Work — the reasons to open the app every morning
status: todo
depends_on: [MN-045]
size: L
---

**Problem.** Mentions send an email (if SMTP is up) and vanish; assignments are silent; there is no cross-database "what's on my plate" view. Linear's daily loop is Inbox + My Issues — without an equivalent, a team cannot *live* in StoryOS.

**Research.** Linear Inbox: one stream of things aimed at you (assigned, mentioned, status changes on subscribed issues), read/unread, snooze, keyboard triage; My Issues: assigned-to-me across all teams grouped by state. Fibery: notifications panel + "My space". Notion: Inbox with mentions + comments. Synthesis: **an inbox is a per-user event stream filtered to personal relevance (assigned to me, @mentioned, comment on a record I created/commented on), plus one saved cross-database view of records where any person-field = me**.

**Design.**

- Table `notifications`: userId, workspaceId, type (`mentioned` | `assigned` | `commented`), recordId + databaseId, actorId, readAt, createdAt. Producers hook the existing activity pipeline: person-field change → `assigned` for added users; comment with @mention → `mentioned`; comment on a record the user created or previously commented on → `commented` (skip self-actions).
- API: list (unread first, cursor), mark read / mark all read; unread count endpoint.
- Web: bell in the header with unread badge → inbox panel: rows show actor avatar, record title, database, snippet; click navigates; "Mark all read". Poll every 60s (no websockets in v1).
- **My Work** page (`/w/:ws/me`): all records visible to me across databases where any `user`-type field contains me, grouped by database, sorted by due-date-if-present; linked from the sidebar above spaces. Server endpoint does the cross-database query honoring grants.
- Email stays as-is (mentions), now also linking to the record.

## Acceptance criteria

- [ ] Notifications produced for assignment, @mention, comment-on-my-thread; never for my own actions
- [ ] Inbox UI with unread badge, mark read/all-read, navigation; 60s polling
- [ ] My Work aggregates person-field matches across databases with grant scoping (guest sees only granted content — test)
- [ ] Integration tests: each producer, read-state transitions, guest scoping
