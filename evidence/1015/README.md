# Ticket #1015 — the seven starter packs' main boards, right after install (acceptance criterion 4)

One fresh install per pack (sample records on), signed in as the installing person, the pack's main board at 1270 px, dark theme,
taken 2026-10-24 on a local build of `main` (PR #1210's sample cards are on `main`). Each screenshot is a real browser capture of the
running app, not a render of the test data.

| Pack | Board | File | What the cards show |
|---|---|---|---|
| Agency OS | Task Board | [agency-os-task-board.jpg](agency-os-task-board.jpg) | priority chip, assignee ("Pack Shots"), due date (overdue and upcoming); grouped by State |
| Client Portal | Shared Board | [client-portal-shared-board.jpg](client-portal-shared-board.jpg) | assignee, relative due date ("Yesterday"), a "Waiting" chip; first two columns (Triage, Backlog) legitimately empty |
| Dev Project OS | Issue Board | [dev-project-os-issue-board.jpg](dev-project-os-issue-board.jpg) | priority, assignee, a type chip (Feature / Improvement / Chore) |
| Content Engine | Editorial Board | [content-engine-editorial-board.jpg](content-engine-editorial-board.jpg) | content-type chip, assignee, publish date; grouped by Stage |
| Book Launch | Manuscript Board | [book-launch-manuscript-board.jpg](book-launch-manuscript-board.jpg) | chapter number and word count (no assignee on this board by design); grouped by Status |
| Coaching OS | Session Board | [coaching-os-session-board.jpg](coaching-os-session-board.jpg) | date, session type, the linked client chip; "No-show" column present and empty |
| Consulting OS | Pipeline Board | [consulting-os-pipeline-board.jpg](consulting-os-pipeline-board.jpg) | deal value, close date, the linked client chip; grouped by Stage |

## What these do and do not show
- Every card has fields filled, none is title-only, and cards are spread over several columns (the board is wider than the capture; the
  rightmost columns are cut off at the viewport edge).
- Not shown: light theme, 390 px mobile, and the columns off to the right of the 1270 px viewport.
- Local setup note: the dev database needed `pnpm db:migrate` first (a stale local schema made the API answer 500); that is the local
  rig, not the product.
