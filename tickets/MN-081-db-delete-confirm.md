---
id: MN-081
title: Restore typed-name confirmation on database delete (regression)
status: todo
depends_on: []
size: S
---

Bug: clicking the Trash icon on a database deletes it immediately with no confirmation. It used to require typing the database name (ADR/meta-model: databases are hard-deleted with typed-name confirm). This is a dangerous regression.

## Design
- Restore the confirm dialog: user must type the exact database name to enable Delete; Delete stays disabled otherwise. Sends sever_relations:true as before.

## Acceptance criteria
- [ ] Trash opens a dialog requiring the exact name typed before Delete enables
- [ ] Wrong/empty name keeps Delete disabled; correct name deletes
- [ ] Verified in browser
