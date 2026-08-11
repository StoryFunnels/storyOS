# Field surfaces: one component per field type, one rule per capability

How StoryOS renders and gates **fields** across every surface that touches them
— table cells, the record page, forms, filter/sort/group pickers, dashboards.
This is the standing convention from #303. It exists because the same defect has
now shipped four times, and each recurrence was a *fresh copy* of a rule or a
control that already existed somewhere else.

> **TL;DR** — never re-`switch` on `field.type`, and never re-`filter` on it.
> Render through the shared cell components; gate through the shared capability
> predicate. A new surface **wraps** those; it does not reimplement them.

## The problem

A field type has two things every surface needs to know:

1. **How do I draw and edit it?** (a colored option badge, a relation chip with
   its database marker and `#number`, a person's avatar)
2. **Can this field do X?** (can a board group by it, can a list group by it,
   can it be hidden, filtered, sorted, charted)

Both were answered by hand, per surface. The copies drifted, and drift is
invisible: nothing fails to compile, no test breaks, and the surface that has the
*older* answer looks like a bug in a feature nobody touched.

### The four recurrences

| # | Symptom | The duplicate |
|---|---|---|
| #267 | Workflow/State missing from Filter / Sort / Color / group pickers | each picker filtered `field.type` inline |
| #272 | State missing from the Fields (column-visibility) picker | a *different* inline list, so #267's fix didn't reach it |
| #272 (2nd) | State missing from **List → Group by**, though `list-view` renders workflow groups fine | `page.tsx` built the List list as `f.type === 'select'` while the Board list next to it was correct |
| #303 | Forms show a native `<select>`, plain-text relation search, and no avatars | `form-view.tsx` carries its own `case` ladder for all ten field types, importing nothing from `cells.tsx` |

#267 was closed as *"fixed everywhere."* It wasn't, because "everywhere" is not
knowable when the rule is written out at each call site.

A related instance, same shape, different axis: **#305** — `cleanViewConfig`
required a configured field before it would keep a dashboard tile, so it deleted
tiles that were merely *unconfigured*. That one wasn't a duplicated rule but a
rule that conflated two states. Both failures come from a rule living where
nobody can see all of its consequences.

## The convention

### 1. Rendering: `table-view/cells.tsx` is canonical

`CellDisplay` / `CellEditor`, plus the exported primitives — `OPTION_COLORS`,
`OptionList`, `RelationChip`, `RelationChips`, `Avatar` — are the only
implementations of "what does a field of type T look like."

A surface with different *chrome* (a form wants a stacked label, description and
required marker; a cell wants click-to-edit) wraps the shared control in that
chrome. It does not re-render the control.

**Do not** "make surface B look like surface A" by copying styles across. Copied
styles drift again in a month — that is precisely how #303 happened.

### 2. Capability: one predicate per capability, mirroring the server

The server is the authority, because it rejects bad configs on write.
`boardGroupError` (`apps/api/src/views/views.service.ts`) decides whether a board
may group by a field, and it has its own unit tests. The web's job is to **not
offer** what the server will refuse.

Today's shared predicates live in
`apps/web/src/components/views/groupable-fields.ts`:

- `canGroupBoardBy()` — mirrors `boardGroupError`. Single-valued only: a
  multi-user field, a many-to-many, or the many side of a one-to-many would put
  one card in several columns.
- `canGroupListBy()` — deliberately narrower: exactly what `list-view` can
  render. **Widen the predicate and the renderer in the same commit**, never one
  alone; that mismatch *was* the #272 bug.

When you need a new capability gate, add a named predicate beside these. Do not
inline it.

### 3. Legitimately different rules stay separate — but say so

Not every surface should share one rule, and pretending otherwise is its own bug:

- **Dashboard chart grouping** allows `multi_select`, `date` and `checkbox`. A
  chart bucket may be multi-valued where a board column may not — a record can
  legitimately count in two buckets.
- **`my-work/group-config.tsx`** has its own surface and lifecycle.

Both are intentionally outside `groupable-fields.ts`. If you find a divergence,
check this list first: it is either a deliberate difference (documented here) or
a fifth recurrence.

### 4. Unconfigured is not invalid

Config-cleaning code (`cleanViewConfig`) must distinguish:

- **dangling** — names a field that no longer exists → drop it;
- **unconfigured** — names nothing yet → **keep it**; the user is mid-edit.

Deleting the second silently destroys work in progress. See #305, where
switching a tile Count→Sum produced `{op:'sum'}` with no field and the tile was
garbage-collected on the very next read.

## Checklist — adding or changing a field surface

- [ ] Renders through `cells.tsx` components; no new `switch (field.type)` for
      display or editing.
- [ ] Any "can this field do X?" gate is a named shared predicate, not an inline
      `.filter(f => f.type === …)`.
- [ ] If the gate has a server counterpart, the predicate **mirrors** it, and the
      comment names that function.
- [ ] Renderer and picker widened together, in one commit.
- [ ] A deliberately different rule is added to §3 above with its reason.
- [ ] Config-cleaning keeps unconfigured entries; only dangling ones are dropped.
- [ ] Unit tests cover the *rejections*, not just the happy path — the
      multi-value cases are the reason the rules are narrow.

## Why the tests didn't catch any of this

In every case the existing tests passed. #305's six tile/widget assertions all
still pass **unchanged** under the corrected rule, because none of them encoded
the buggy behaviour — they tested that dangling fields are dropped, never that
unconfigured ones survive. The lesson: when a rule filters things out, test what
it must **keep**.
