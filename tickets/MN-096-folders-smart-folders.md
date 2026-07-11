---
id: MN-096
title: Folders & Smart Folders — organize the sidebar as spaces fill up
status: todo
depends_on: [MN-088]
size: M
---

## Fibery parity

Within a space, Fibery lets you group databases / views / documents into **Folders**
(manual grouping) and **Smart Folders** (auto-grouping by a rule, e.g. all views of
type Board, or items matching a filter). Essential once a space has 20+ items — the
sidebar becomes a real information architecture, not a flat dump.

## Scope

- **Folder**: a named, collapsible container inside a space that holds databases /
  documents / views in a chosen order. New entity `space_folders {id, space_id,
  name, icon, position}` + a nullable `folder_id` on the items it can hold; sidebar
  renders the folder tree (collapsible per MN-088).
- **Smart Folder**: a folder whose contents are computed from a rule (item type /
  name match / tag) rather than manual membership — read-only grouping.
- Drag items into/out of folders; reorder.

## Open questions

- Which item types live in folders v1? (Recommend: databases + standalone docs.)
- Smart Folder rule surface — keep tiny (by type, by name contains) for v1.

## Acceptance criteria

- [ ] Create a folder in a space; move databases/docs into it; collapse/expand; reorder.
- [ ] Smart Folder with one rule auto-lists matching items (read-only).
- [ ] Persists; respects space access; empty folders render cleanly.

Refs: [Fibery Views](https://the.fibery.io/@public/User_Guide/Guide/Views-8).
