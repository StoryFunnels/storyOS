# Automations

Rules that run actions when records change or on a schedule. Open them from a database's
`⋯` menu → **Buttons & automations**.

## The one thing to know first

**Buttons and rules run the same actions.** There is a single action set in StoryOS, and
every action in it is available to a button *and* to a scheduled or triggered rule. If you
have seen an action offered on a button, a rule can do it too — including sending email and
calling any HTTP API, unattended, with nobody clicking anything.

This is worth stating plainly because the opposite has been concluded from an earlier version
of this page: that outbound HTTP was button-only and that email was missing altogether. Both
were wrong, and both capabilities had shipped months before.

## The full action list

Eleven actions, all available to buttons and rules alike.

| Action | What it does |
|---|---|
| **Set fields on this record** | Writes values onto the record that triggered the rule. |
| **Create a record** | Creates one record in any database, optionally linked back through a relation. |
| **Create many records** | Creates 0–200 records from one template. The count can be a number or a `{Field}` token read at run time; `{index}` (1-based) differentiates them — "Day {index}". |
| **Add a comment** | Posts a comment on the record. |
| **Notify a person** | An in-app notification to a person field's value, or `@me`. |
| **Update linked records** | Sets fields on every record linked through a chosen relation. |
| **Send a Slack message** | Posts to a channel, or the workspace's default channel. |
| **Send a webhook** | POSTs to a URL you name, with the standard record payload or your own body. |
| **Send an email** | A templated 1:1 email through a Resend or SMTP connection. See below. |
| **Call an API** | Any method, any URL, optional auth, and it can read the response back onto fields. See below. |
| **Run an agent** | Launches an agent from the Agents database against the triggering record. |

Every action supports the `@me` / `@today` / `@now` tokens and `{Field Name}` interpolation.
A rule carries between 1 and 10 actions.

## Anatomy of a rule

**When** (trigger) → **Only if** (condition) → **Then** (actions)

- Triggers: *record created* · *record changes* (optionally scoped to one field — "when State
  changes") · *record linked or unlinked* through a relation · *schedule* (hourly / daily /
  weekly at HH:mm, server time) · *webhook received* (an inbound URL the outside world POSTs to).
- Condition: any filter the views support; for scheduled rules the condition **is the selection** —
  the rule runs over every matching record.
- Actions: the eleven above. Each action can also carry its **own** condition, checked against
  the record just before that action runs — so a rule can validate first and only then fire an
  email or an API call. A failed per-action condition skips that one action and the rest still run.

## Sending email

An email action needs a **connection** — StoryOS never sends as an address you have not proved
you own. Set one up at **Settings → Connections** (Resend or SMTP), including a from-address;
for Resend, on a domain Resend has verified for that key. The connection's own from-address is
what the mail sends as. You cannot type a `from` on the action.

Fields: `to` and `cc` (comma-separated, templated), `reply_to`, `subject`, and a markdown body.
All of them interpolate `{Field Name}` and `{payload.…}` tokens.

**Approval is on by default, and the default is decided at run time.** When you have not set the
approval flag either way, StoryOS renders the recipients and checks them: if every resolved
address belongs to a member of this workspace, the email sends immediately; if even one address
is external, the send waits for a human approval. Setting the flag explicitly always wins — but
only a workspace admin can save an email action with approval turned *off*. Any member can turn
it on.

What goes wrong, and what you will see:

- Connection missing or deleted → the rule refuses to save: *"send_email references an unknown connection"*.
- Connection is not Resend or SMTP → refused, naming the provider you actually picked.
- Connection has no from-address yet → refused, telling you to reconnect it with one.
- Non-admin turning approval off → *"Only a workspace admin can turn off approval for a send_email action."*

## Calling an API

Method (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`), a templated URL, optional headers, optional body.
The URL is a template, so `https://api.example.com/orders/{payload.id}` is legal — which means
the host is only checked when the request is actually sent, not when you save the rule.

**Auth belongs on a connection, not in the action.** Create an `http` connection (bearer token,
basic auth, or a set of headers) and reference it. Its credentials are merged into the request
at send time only; they are never written into the stored rule and never appear in a run log.
Putting a token directly in a header on the action means it is stored as you typed it — use a
connection instead.

**Capture** reads values out of a 2xx JSON response and writes them onto the record. Each capture
row is a dot/array path (a leading `$.` is stripped, so jq-style paths work) and a target field.
Up to 10 rows.

What goes wrong, and what you will see:

- **Any status ≥ 400 fails the action**, with the status and a body snippet in the run log.
  5xx and 429 are retried with backoff; 4xx is not.
- A blocked host (StoryOS refuses to call private/internal addresses) fails **without** retrying —
  it is a refusal, not a blip.
- The response body is capped at 1 MB, and the logged result or error at 8 KB.
- If capture cannot parse the response as JSON, the *request still counts as successful* and the
  run records a separate `capture_error` — the call happened, the fields did not update.

## What a webhook-triggered rule cannot do

A rule triggered by **webhook received** has no triggering record, so it can only run actions that
do not need one: *create a record*, *create many records*, *send a Slack message*, *send a webhook*,
and *notify a person* (`@me` only). Saving any other action on such a rule is refused, and the error
lists what is allowed.

This is the one place where the "buttons and rules do the same things" rule has an exception — and
it is about the missing record, not about the action being dangerous. **Email and API calls are not
available on a webhook-triggered rule.** Have the webhook create a record, and let a
record-created rule do the outbound work.

## Recipes

| Goal | Rule |
|---|---|
| Escalate urgent tickets | When **State** changes · only if State is *Urgent* · add comment "⚠️ {Title} needs eyes" |
| Auto-stamp start dates | When **State** changes · only if State is *In Progress* · set *Started* = `@today` |
| Close stale Done work | Every day at 03:00 · only if State is *Done* · set *Archived* ✓ |
| Kickoff checklist on new client | When a record is created (Clients) · create a record in Tasks "Kickoff {Title}" linked back |
| Email the client when work ships | When **State** changes · only if State is *Delivered* · send an email to `{Client Email}` |
| Enrich a new lead | When a record is created · call an API `GET https://api.example.com/lookup/{Domain}` · capture `company.size` onto *Headcount* |
| Nightly sync to another system | Every day at 02:00 · call an API `POST https://api.example.com/sync` with a `{Field}`-templated body |
| One task per sprint day | When a Sprint is created · create many records, count `{Length In Days}`, title "Day {index}" |
| Auto-assign triage | When a record is created · set *Assignee* = `@me` |

## Semantics worth knowing

- **Attribution**: runs act as the rule's creator; activity shows their name on the changes.
- **Loop guard**: an automation's own writes can trigger other rules **at most one more hop**
  (depth 2). Deeper cascades are skipped and logged — a rule can never ping-pong forever.
- **External actions are queued, not inline.** Email, API calls and agent runs are handed to a
  durable job runner rather than run during the record's save, so a slow or flaky endpoint retries
  with backoff instead of stalling the write or firing twice on a retry. The run log is where you
  find out what happened, not the record's save.
- **Auto-disable**: 10 consecutive failures switch a rule off (banner in the panel); editing the
  actions or re-enabling resets the streak.
- **Run log**: every execution (ok / error / skipped / skipped_quota) with duration is kept for 90
  days, and queryable across the whole workspace at `/w/:ws/runs` (or `GET /workspaces/:ws/runs`)
  alongside quota status.
- **Dry run**: `POST …/automations/:id/test { record_id }` answers "would this run?" without writing.
- **CSV imports do not fire automations** (mass-import safety, same choice as Airtable).
- Scheduled rules process up to 500 matching records per tick and note truncation in the server log.
