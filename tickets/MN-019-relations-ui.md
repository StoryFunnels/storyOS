---
id: MN-019
title: Relations UI
status: done
depends_on: [MN-016, MN-018]
size: M
---

The heart of the product, client side. Add-relation flow in the field dialog (searchable target-database picker across spaces, plain-language cardinality choice, both field names editable); relation cells in the table rendering linked-record chips; the record picker popover (title search via `q`, "+ Create '<name>'" inline, single vs multi chips by cardinality).

## Acceptance criteria

- [ ] Create a relation entirely from the UI; toast deep-links to the inverse field on the target database
- [ ] Pick/unlink records from a relation cell; both sides update without reload
- [ ] Inline-create a target record from the picker
- [ ] Cardinality respected in the UI (single-chip replace vs multi-chip add)
- [ ] Guest sees name-only, non-navigable chips for records in unshared spaces
