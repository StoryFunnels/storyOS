---
title: Share a portal with a client
description: Give a client an intake form to send work in and a scoped space to watch it move — read-and-comment access, everything else invisible, no per-seat cost.
sidebar:
  order: 1
---

A **client portal** is two everyday StoryOS pieces pointed at one person outside your team:

1. A **public form** they use to send work in — no account required.
2. A **scoped space** they're invited into as a **guest**, where a filtered view shows just
   their work and they can read and comment.

Nothing here is a special "portal" object. A portal is a form plus a guest grant on a space — which
means the same primitives run your own workspace and your clients' windows into it. Guests are
scoped collaborators, not workspace members, so giving every client a portal doesn't cost a seat.

This guide sets one up end to end. It assumes you're an **admin** (inviting guests and granting
access is an admin action).

## 1. Collect work with a public form

A form is a [view](/concepts/views/) type: it renders a database's fields as inputs, and submitting
creates a record.

1. Open the database you want work to land in (say, *Requests*), add a **Form** view, and use the
   builder to pick the fields the client should fill. For each field you can set a **label**, **help
   text**, and whether it's **required**.
2. Open the **Share** panel and click **Create a shareable link**. Set the access mode:
   - **Members only** — stays behind the app login (not a portal).
   - **Anyone with the link** — anyone who has the URL can submit.
   - **Public** — same, and fine to index or embed publicly.
3. Copy the **Link** (it looks like `https://your-host/f/<token>`) or the **Embed** snippet — a
   responsive `<iframe>` you can drop into your own site.

Submissions come in **anonymous**: the record's author renders as a deactivated user, since the
sender has no account. A hidden honeypot field and per-IP rate limiting keep out casual bots, so you
can share the link openly.

:::tip
Only the fields you add to the form are accepted. Anything else a caller tries to send is ignored,
so a public form can never write to columns you didn't expose.
:::

### Showing or requiring a field only when an earlier one matches

Expand a field in the builder and it carries two independent rule rows:

- **Show only when** — the field only appears once an earlier answer matches.
- **Require only when** — narrows *when* **Required** applies; it only appears once you've
  checked Required, since it means nothing otherwise.

Both rows work the same way: pick an **earlier** field (a form field can only depend on one that
comes before it — no forward references, no cycles), then a condition — **is answered**, **is
empty**, **is** (with a value picker), or **is not**. A select or workflow field gets a dropdown of
its own options rather than free text, since the stored value is the option id, not its label.

**Enforcement is real, not cosmetic.** A field hidden by its own rule can't be submitted a value at
all — the server refuses it, so a hand-crafted request can't bypass what the builder hides. A
required field is only actually required while its own rule holds; leave **Require only when**
unset and it's simply always required, same as before this existed.

**Unchecking Required clears any "Require only when" rule with it**, rather than leaving an
orphaned condition sitting in the form's saved config.

### Narrowing a relation field's choices

A **relation** field in the builder gets its own **Filter candidates** control — the same filter
builder [views](/concepts/views/) use, scoped to the field's target database. Set a condition
(*"Status is Active"*, say) and the field's picker only offers matching records, instead of every
record in that database.

**Enforced server-side, the same way visibility is.** The filter narrows both the live search a
visitor types into and what a submission is allowed to name — a crafted request naming a filtered-out
record's id directly is refused, not just hidden from the picker's own search. Leave no filter set
and the picker behaves exactly as it always has: an unfiltered search across the whole target
database.

### Collecting a file

A form can take an **attachment** field, so a client can send a brief, a screenshot or a signed PDF
along with the answers. Add it in the builder like any other field; the public page then shows a
file picker and uploads the file with the submission.

- **One attachment field per form, and one file per submission.** The builder refuses a second
  attachment field (the button explains why). Anything beyond one file is rejected with a `422`
  — *"only one file may be submitted"* — rather than silently keeping the first.
- **The usual size cap applies** — the same limit as an upload inside the app (20 MB unless your
  self-hosted instance sets `ATTACHMENT_MAX_BYTES`); a bigger file is a `422`, not a partial save.
- **Required means required.** A required attachment field with no file is a `422` naming the
  field, same as any other required answer.
- **Over the API**, a form with an attachment field accepts `multipart/form-data`: a `payload`
  part holding the same JSON body as always (`{ values, … }`) plus at most one file part. A form
  without an attachment field is still JSON-only, and a file sent to it is refused.

### Stamping a fixed value the visitor never sees

A field can be **hidden** and carry a fixed **value** that's written onto every record the form
creates — a job or tenant id, a lead-source tag, a UTM campaign — so one form per job or channel
tells you where each submission came from without asking the visitor.

- **It comes from the saved form, never the request.** A visitor who posts their own value for a
  hidden field is ignored; the stored one is stamped regardless.
- **Supported for relation, text, select and workflow fields.** The value is validated when the
  form is saved — a select's value must be a real option id (not its label), a relation's must
  name a record that exists in the target database.
- **Hidden means never shown to anyone**, so it can't be combined with **Show only when**; the API
  rejects the pair as a config error. **Required** on a hidden field never blocks a submission.
- **No toggle in the form builder yet** — set `hidden` and `value` on a field through the API, or
  with `create_view` / `update_view` over MCP (`form_fields`).

## 2. Give the client a scoped space

[Spaces](/getting-started/concepts/) are the unit of guest access. The cleanest portal is **one
space per client**: put that client's databases (their board, their requests, their deliverables) in
their own space, and everything outside it stays invisible.

1. Go to **Settings → Members → Invite**, choose the **Guest** role, and select the space(s) this
   client should reach. They get an email invite.
2. Open the space (or a single database) you want to share and open its **Share** dialog — *Access
   to "…"*. Add the guest and pick their **role** for this scope.

Grants attach to **one scope** — a space or a single database — so you can hand a client a whole
space or just one database inside a space you otherwise keep private.

## 3. Choose what the client can do

StoryOS access is a single graded ladder — each role is a superset of the one below. For a client
portal you'll almost always pick one of the first three:

| Role | What the client can do |
|---|---|
| **Viewer** | Read the records and views you shared. Nothing else. |
| **Commenter** | Read **and comment** — the right default for a status portal where the client weighs in without editing. |
| **Contributor** | Read, comment, and **add or edit records** — but never delete. Good when the client should file and update their own items. |
| Editor / Creator | Higher rungs (delete records/views, edit schema). Rarely what you want for an outside client. |

Pick the **lowest** role that lets the client do their job. You can change or revoke it any time from
the same Share dialog.

## 4. Show them a filtered view

Inside the client's space, build a [view](/concepts/views/) filtered to what they should see —
a board of just their active requests, a table of their deliverables. Because the space is theirs,
that view *is* their landing page. Save the filters and sorts you want them to open into.

## What clients can and can't see

Guest scoping is enforced by the API, not just hidden in the UI:

- **Everything outside their granted spaces returns 404**, not 403 — the product never even reveals
  that other resources exist.
- **Cross-space relation chips render name-only and non-navigable.** If a record they can see links
  to another client's space, they get a label and a dead end, never a way in.
- Guests can **read and comment** (at Commenter or above) but aren't `@`-mentionable yet.
- A [personal access token](/api/authentication/) a guest creates inherits **their** role and
  scoping — so an [MCP](/mcp/overview/) agent you hand a guest-scoped token can only ever touch that
  guest's spaces.

## Put it together

A working agency portal is usually:

- a **public intake form** on a *Requests* database (step 1), linked or embedded on your site;
- a **per-client space** holding that client's board and deliverables;
- the client invited as a **Commenter** (or **Contributor**) guest on their space (steps 2–3);
- a **filtered board** they open into to watch work move and leave feedback (step 4).

The client sends work in through the form, watches it move on the board, and comments in place —
while every other client's work stays invisible, and you never pay for the seat.

## When a guest seat doesn't fit

This guide's model — invite the client as a guest — is the right one when a handful of clients
each need to work inside their own space. It stops fitting once you have dozens of clients who
only ever need to read their own slice of one shared view: that many guest seats gets expensive
fast, even at the free viewer/commenter tier's floor. [Portal
recipients](/concepts/portal-recipients/) are the API/MCP-only alternative built for exactly that
shape — a named external party with a revocable link, never a user, never a seat.

## Related

- [Access & roles](/concepts/access-and-roles/) — the full role ladder and guest-scoping rules.
- [Views](/concepts/views/) — filters, sorts, and the board/table/calendar/form view types.
- [Portal recipients](/concepts/portal-recipients/) — the no-seat alternative for many read-only clients.
- [Core concepts](/getting-started/concepts/) — where spaces, databases, and records fit.
