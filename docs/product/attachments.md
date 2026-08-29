# Files and attachments

There are two places a file can live on a record, and they answer different questions.

| | The record's file bag | An attachment **field** |
|---|---|---|
| What it is | A pile of files on the record | A column, like any other field |
| Answers | *"what's attached to this?"* | *"what is this record's Cover?"* |
| Shows in a table view | No | Yes, as a column |
| Order | Newest first | The order you put them in |
| How many | One bag per record | As many fields as you want |

If you have ever faked a "Cover" or "Contract" column with a URL field pointing at a file
somewhere else, the attachment field is what you actually wanted.

## The record's file bag

Every record has one. Drop files on the record and they collect there. Nothing about this changed
when attachment fields arrived — a record's bag holds exactly what it always held, and adding a
Cover field does not move anything into it or out of it.

## Attachment fields

Add a field of type **Attachment** and it behaves like every other column: it appears in table
views, it can be reordered, a record can have several of them, and each one holds its own ordered
list of files.

**The order is yours.** Files sit in the order you put them, not the order they were uploaded, and
you can rearrange them. For a Cover or a Gallery that matters — the first file is usually the one
that gets shown.

**Uploading is its own step.** A file goes into a field by being uploaded to that field. Setting
the field's value can then reorder or remove what is already there, but it cannot pull in a file
that was uploaded somewhere else — pointing a field at a stranger's attachment is refused, and the
error says to upload through the field instead.

That may read as fussy; it is what stops a file appearing in two records at once and being deleted
out from under one of them.

## Limits and formats

- **20 MB per file** by default. Self-hosters can change this (`ATTACHMENT_MAX_BYTES`).
- **Images get a thumbnail**; other files do not. A card knows in advance whether a thumbnail
  exists, so you get an honest placeholder rather than a broken image.
- Any file type. StoryOS does not interpret the contents.

## What you cannot do

- **CSV import cannot create an attachment field.** A cell is text and a file is not, so an import
  that "created" one would give you a column that is empty for every row. Import the records
  first, add the field, then upload.
- **A file is data.** Deleting an attachment destroys the only copy — there is no trash for it, and
  Tyron treats it as a real delete rather than housekeeping.

## Over the API and MCP

- `attach_file` uploads. `list_attachments` reads. `delete_attachment` removes.
- Over REST, `POST …/attachments` puts a file in the record's bag; `POST …/attachments?field=<id>`
  puts it in an attachment field instead.
- Reading a record returns each attachment field as an ordered list of chips — id, filename, size,
  MIME type, and whether a thumbnail exists.
