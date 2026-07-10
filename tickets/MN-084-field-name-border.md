---
id: MN-084
title: Field edit dialog — name input border clips on the left (design bug)
status: done
depends_on: []
size: S
---

Bug: when editing a field, the border/outline around the Name input is cut off on the left edge. Likely an overflow/negative-margin/ring-offset clipping in the dialog. Fix the padding/overflow so the input border renders fully.

## Acceptance criteria
- [x] The Name input's border/focus ring renders fully on all sides in the field dialog
- [x] Verified in browser
