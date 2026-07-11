---
id: MN-097
title: Editor image uploads — embed images in descriptions & documents
status: done
depends_on: [MN-095]
size: M
---

## Problem

BlockNote's image block only offered "Embed by URL" — no way to upload a customer's
image into a description or a standalone document. We need to store customer
images/files and embed them inline.

## Design

- New `workspace_files` table (workspace-scoped) + `FilesService` using the existing
  storage driver (local disk / S3-MinIO, same as attachments).
- **Upload** `POST /workspaces/{ws}/files` (auth'd, multipart "file", image/* only,
  10 MB cap) → `{ id, url }`.
- **Serve** `GET /files/{id}` — **public capability URL** (unguessable uuid, no auth,
  throttle-exempt, `cache-control: immutable`) so embedded `<img>` tags load without
  cookies/CORS in both dev (split-origin) and prod (same-origin via Caddy).
- Web: a shared `uploadEditorImage(ws, file)` wired as BlockNote's `uploadFile` in
  all three editors — standalone documents, record descriptions, and rich-text fields.
  The image block now shows an **Upload** tab alongside Embed.

## Acceptance criteria

- [x] Upload an image in a doc/description → it stores and renders inline.
- [x] Served by a public capability URL; non-image uploads → 422; >10 MB → 422.
- [x] Works in all three editors (doc page, description, rich-text field).
- [x] Verified end-to-end: upload → `{id,url}`, public serve 200 image/png, reject 422.

## Follow-ups
- Signed/expiring URLs instead of permanent capability URLs (hardening).
- Non-image file embeds; drag-drop straight onto the editor; orphan-file GC.
