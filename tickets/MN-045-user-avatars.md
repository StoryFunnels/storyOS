---
id: MN-045
title: User avatars — pictures for people everywhere a person appears
status: todo
depends_on: [MN-029]
size: M
---

**Ask (founder, 2026-07-09):** pictures for the users.

**Research.** Linear: avatar or auto-generated initials on a deterministic per-user color; avatars appear on issues, boards, comments, assignee pickers — recognition at a glance is the point. Notion/Slack: upload + crop, initials fallback. better-auth already has a `user.image` column (used for OAuth profile pictures). Synthesis: **one Avatar component (image → fallback to initials on a stable color hashed from the user id), upload through the existing attachments storage driver, shown in every person context**.

**Design.**

- `Avatar` component: `image` if set, else initials (first letters of first/last word) on one of the 10 palette colors picked by user-id hash; sizes 16/20/24/32.
- Upload: profile menu → "Set photo" (new lightweight account popover on the user name in the header, replacing the bare text) → file input → resized client-side to 256px → stored via the existing storage driver under `avatars/`, served through a public-safe route; `user.image` updated via better-auth.
- Render everywhere a person shows: person-field cells and property rows (avatar + name), comment headers, mention chips, members page, assignee pickers, board cards.
- Google OAuth users get their Google picture automatically (already in `user.image`).

## Acceptance criteria

- [ ] Avatar component with initials fallback on stable per-user color
- [ ] Photo upload from the account popover; stored via storage driver; 256px cap
- [ ] Avatars render in person cells, pickers, comments, mentions, members page, board cards
- [ ] Users without photos look intentional (initials), not broken
