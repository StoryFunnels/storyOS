---
title: The Lead Follow-up pack
description: What the built-in Lead Follow-up pack creates, its three databases and views, the stage notification, and the Lead Follow-up Drafter, which installs switched off and only ever drafts for a person to approve and send.
sidebar:
  order: 15
---

**Lead Follow-up** is a built-in Business Pack for anyone with leads to follow up. Leads move through stages, a
**Lead Follow-up Drafter** agent prepares the next message into a Follow-up record, a person reads and approves it,
and the person sends it from their own email or WhatsApp. **StoryOS never sends.** The pack's slug is
`lead-follow-up`. It installs into a space named **Lead Follow-up** unless you
[choose another space](/mcp/tools/#installing-a-pack-into-an-existing-space), and it declares that it needs your own
AI, for its agent.

## What it creates

Three databases, linked as shown:

| Database | Fields |
|---|---|
| **Leads** | **Stage** (see below), **Source** (Referral, Inbound, Outbound, Event, Partner), **Company**, **Contact Email**, **Phone** (text), **Preferred Channel** (Email, WhatsApp, Phone), **WhatsApp Consent** (a checkbox), **Consent Note**, **Do Not Contact** (a checkbox), **Interest** (Brand identity, Website, Packaging, Illustration, Other: edit these for your business), **Deal Value** (USD), **Owner**, **Last Contact**, **Days Since Contact** (a formula), **Next Step**, **Next Step Date**, **Lost Reason** (Budget, Timing, Competitor, Ghosted, Bad fit), **Notes** |
| **Follow-ups** | One record per drafted message: **Lead** (a link to Leads), **Stage At Draft**, **Channel** (Email, WhatsApp), **Subject** (email only), **Draft**, **Status** (Drafted, Ready for review, Approved, Sent, Skipped), **Send After**, **Approved By**, **Sent On**, **Reviewer Note** |
| **Stage Guide** | One record per stage, written by you: **Stage**, **Goal**, **Must Include**, **Never Say**, **Wait Days**, **Booking Link**, **Signature** |

A lead's **Stage** has eight options: **New** (backlog), **Contacted** (unstarted), **Call Booked**, **Proposal Sent**
and **Negotiating** (started), **Won** (completed), and **Lost** and **Not now** (canceled). See
[Option categories](/guides/pack-manifest/#option-categories). The Stage Guide is read by stage name, so it has no
link to Leads.

**Days Since Contact** is the whole days from **Last Contact** to today. It is recalculated when the lead is
saved, so a lead nobody has touched shows the number it had the last time it was saved.

## Views

- **Lead Pipeline**: a board of leads grouped by Stage.
- **Ready for Review**: Follow-ups whose Status is Ready for review, oldest first. This is the approval queue.
- **Going Quiet**: leads whose Last Contact was more than seven days ago and whose Stage is not Won, Lost or Not
  now, longest quiet first. It filters on the date itself rather than on Days Since Contact, so it stays right as
  the days pass. A lead with no Last Contact is not listed.

## The automation

**Notify on lead stage change** is on at install. When a lead's Stage changes, the lead's **Owner** is notified:
the cue to run the drafter or to review its draft. It counts as one automation run.

## The agent

**Lead Follow-up Drafter** runs on your own AI and installs switched off: its eight wake switches, one for each
stage, are off until you turn them on in the install review or on the Agent Triggers database. Nothing is drafted
until you do.

It reads the lead, the Stage Guide record for the stage the lead entered, and the lead's earlier Follow-ups. It
writes one new Follow-up linked to the lead, with Status **Ready for review**, and nothing else. Its instructions
say it:

- never sends, schedules or queues anything, and never sets a Follow-up to Approved or Sent;
- drafts nothing when **Do Not Contact** is ticked;
- drafts for WhatsApp only when **WhatsApp Consent** is ticked and only 1:1, never to a group, and otherwise drafts an
  email and says why in Reviewer Note;
- uses only facts in the record and the Stage Guide, leaving a visible slot such as `⟦CALL TIME⟧` for anything missing;
- uses no pressure, at most one nudge per stage, and one short close on Lost.

The agent's instructions are text a model follows. Two things are enforced by StoryOS instead: its updates to
Leads, Follow-ups and the Stage Guide wait in the Approvals inbox for a person, and a pack agent's trigger never
starts without a person switching it on. The pack's eight stage triggers also carry the condition "Do Not Contact is
unchecked", which StoryOS checks before waking the drafter: a lead marked Do Not Contact wakes nothing, and the skipped
wake is listed with the wake queue. The first rule in the instructions (stop on such a lead) stays as the second line of
defence, for example when a person starts the drafter by hand. Workspaces that installed the pack before this condition
existed keep their triggers as they were; add the condition to each trigger there.

**Approved is a field in your data.** A person sets Status from Ready for review to Approved. That is this pack's
working rule, not a StoryOS permission. A connected assistant such as your own Claude or ChatGPT over MCP is not
held for approval the way the starter agent is: its edits are attributed and badged as AI, and **Ready for Review**
is where you catch them.

After you send an approved draft yourself, set its Status to Sent and fill **Sent On** and the lead's **Last Contact**.

## Sample data

Seven leads (one in every stage except Negotiating, each titled "(sample)") and three Follow-ups that show the whole
loop: a New draft waiting for review, an approved Call Booked confirmation, and a sent Won note. All names and
`.example` addresses are invented. **Remove sample data** deletes those ten records. The eight Stage Guide records
are not sample: the drafter needs them, so they stay. Edit them to say what you want each message to do.

## What it does not do

- Send, schedule or queue any email or WhatsApp message.
- Read your inbox or WhatsApp, or log replies. A person, or their own AI, updates the lead.
- Move a lead between stages.
- Bulk or cold outreach: one draft per lead per stage.
- Score or rank leads.
- Make the consent checkbox a legal record. It is only as good as the person ticking it, and this is not legal
  advice on email or messaging rules.

## How it differs from other packs

It is a pack of its own and links to no other pack. The **Agency CRM** template has a Leads database with almost the
same stages but no Stage Guide, Follow-ups, agent or automation. **Consulting OS** has a Follow-up Drafter bound to
proposals in Negotiating, for firms that also track engagements and hours. **Deal Desk** tracks deals, quotes and
hand-offs. Installing Lead Follow-up next to any of them gives you a second, separate Leads database. When a lead is
Won, create the client in whichever pack you use.
