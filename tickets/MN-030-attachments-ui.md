---
id: MN-030
title: Attachments UI
status: todo
depends_on: [MN-025, MN-029]
size: S
---

The attachments strip on the entity page: upload via button and drag-drop onto the strip, list with filename/size/uploader/date, image thumbnails, download, delete with confirm. Upload progress indication; cap errors surfaced clearly.

## Acceptance criteria

- [ ] Drag-drop and button upload both work with progress state
- [ ] Images render thumbnails; other files render a type icon
- [ ] Download and delete (with confirm) work; list updates without reload
- [ ] Over-cap file rejected with a clear message before/at upload
- [ ] Guests see and download attachments on scoped records but cannot upload/delete
