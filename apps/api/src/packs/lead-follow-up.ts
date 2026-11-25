import { fieldRef, optionRef, sampleDate, sampleRef, SAMPLE_ME } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * ticket #1324 - Lead Follow-up: leads through a stage pipeline, a Stage Guide the owner writes, and a drafter that prepares the next message
 * for a PERSON to approve and send. StoryOS never sends. Built from the Email-Marketing spec (tab 3) with Otto's rulings on the ticket:
 *
 *   - Built on the Agency CRM template's Leads shape (same stage and field names), not as an extension of Consulting OS. It is a SEPARATE pack:
 *     it creates its own Leads, Follow-ups and Stage Guide in its own space and links to nothing else (the template and Agency OS / Deal Desk
 *     each keep theirs). A person who has both installs two Leads databases on purpose; see the pack's docs page.
 *   - The agent is "Lead Follow-up Drafter" (Consulting OS already has a "Follow-up Drafter").
 *   - Phone is TEXT (there is no phone field type).
 *   - One agent trigger per stage (a trigger binds ONE option of ONE field).
 *   - "Going Quiet" is built on Last Contact, with a "Days Since Contact" formula beside it. NOTE the argument order: `days_between(a, b)` counts
 *     from a TO b, so `days_between(today(), {Last Contact})` is negative for a past date; the pack writes `days_between({Last Contact}, today())`.
 *     The view does NOT filter on that formula's value: a formula that reads `today()` is materialized when the record is WRITTEN, so it would go
 *     stale as the days pass. It filters on the date itself with the relative token `$date:-7d` (resolved at query time, #1147), which never does.
 *
 * Why the Stage Guide samples are STRUCTURE (`sample: false`), unlike every other sample here: the drafter reads the guide for the stage a lead
 * enters, so "Remove sample data" must not take its instructions away (the same reasoning as Team Wiki's "Everyone", #1242).
 */
const USD = { format: 'currency', currency_code: 'USD', precision: 0 } as const;

/** A BlockNote document of plain paragraphs: the value shape of a rich_text field. */
const blocks = (...paragraphs: string[]) =>
  paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }));

const STAGES = ['New', 'Contacted', 'Call Booked', 'Proposal Sent', 'Negotiating', 'Won', 'Lost', 'Not now'] as const;
const stageOptions = STAGES.map((label) => ({ label }));

/** Won, Lost and Not now are closed: a lead there is never "going quiet" and never needs the next message. */
const OPEN_STAGES = { field: 'stage', op: 'category_is_not', value: ['completed', 'canceled'] };

const NEVER_SAY = 'No discounts, no deadlines, no "just circling back".';

const AGENT_INSTRUCTIONS =
  'You prepare the NEXT message for a lead, as a draft for a person to read, approve and send themselves. You never send anything.\n\n' +
  'WHAT YOU READ\n' +
  '- The lead: Name, Company, Stage, Interest, Source, Notes, Last Contact, Preferred Channel, WhatsApp Consent, Do Not Contact.\n' +
  '- The Stage Guide record for the lead\'s NEW stage: its Goal, Must Include, Never Say, Wait Days, Booking Link and Signature.\n' +
  '- The lead\'s earlier Follow-ups, so you do not repeat yourself.\n\n' +
  'WHAT YOU WRITE\n' +
  'Exactly one new Follow-up record linked to the lead (its Lead field), with: Title (the stage and the purpose, e.g. "Call Booked: confirmation"), ' +
  'Stage At Draft, Channel, Subject (email only), Draft, Send After (only where the Stage Guide has Wait Days: today plus Wait Days) and ' +
  'Status = Ready for review. You write nothing else, anywhere.\n\n' +
  'WHAT THE STAGE IS FOR\n' +
  '- New: a first reply. Thank them, ask one question, offer a way to book. Same day.\n' +
  '- Contacted: one gentle nudge, used only if there is no reply. After Wait Days.\n' +
  '- Call Booked: a confirmation with the time, what the call will cover and one thing to prepare. Right after booking.\n' +
  '- Proposal Sent: a covering note, and a check-in for later (Wait Days).\n' +
  '- Negotiating: a summary of what changed and what is still open.\n' +
  '- Won: a thank-you and what happens next. Same day.\n' +
  '- Lost: one short, gracious close. Once.\n' +
  '- Not now: a check-in on the date they named (the lead\'s Next Step Date).\n\n' +
  'RULES (they are not optional)\n' +
  '1. If Do Not Contact is ticked, draft nothing at all. Say so in one line and stop.\n' +
  '2. You draft. You never send, schedule or queue a message, and you never set a Follow-up to Approved or Sent. Status is always Ready for review.\n' +
  '3. You never change the lead\'s Stage or any other lead field, and you never edit an existing Follow-up or the Stage Guide.\n' +
  '4. WhatsApp only when WhatsApp Consent is ticked on the lead, and only 1:1. Never a group, never an added colleague. If WhatsApp is preferred but ' +
  'consent is not ticked, draft an email and say why in Reviewer Note.\n' +
  '5. Use only facts that are in the lead record and the Stage Guide. Never invent a price, date, availability, discount, deadline or result. A missing ' +
  'detail stays as a visible slot a person fills in, such as ⟦CALL TIME⟧ or ⟦BOOKING LINK⟧.\n' +
  '6. No pressure: no "last chance", no fake deadlines, no guilt, at most one nudge per stage. Every nudge gives the lead an easy way to say "not now". ' +
  'Honour the Stage Guide\'s Never Say.\n' +
  '7. On Lost, draft one short close and then nothing more for that lead.\n' +
  '8. Sign the message the way the Stage Guide\'s Signature says.\n\n' +
  'Keep it short and plain, in the voice of a person writing to one person.';

export const LEAD_FOLLOW_UP_PACK: PackRegistryEntry = {
  slug: 'lead-follow-up',
  name: 'Lead Follow-up',
  summary:
    'Leads through a stage pipeline, a stage guide you write, and a drafter that prepares the next message for a person to approve and send.',
  highlights: [
    'Leads, Follow-ups and Stage Guide, fully related',
    'Lead pipeline: New → Contacted → Call Booked → Proposal Sent → Negotiating → Won / Lost, plus Not now',
    'A "Lead Follow-up Drafter" agent drafts the next message into a Follow-up record: gated, your call to run it',
    'Notifies you when a lead’s stage changes',
  ],
  manifest: {
    format_version: 1,
    license: 'All rights reserved',
    attribution: 'StoryOS',
    slug: 'lead-follow-up',
    name: 'Lead Follow-up',
    version: '1.0.0',
    why: 'You have leads to follow up and want the right next message drafted for you to approve and send yourself.',
    can: [
      'See every lead by stage and spot the ones going quiet',
      'Get a draft of the next message, written from the lead’s own record and your Stage Guide',
      'Approve the draft, then send it yourself from your own email or WhatsApp',
    ],
    scenario: 'pack',
    summary:
      'Leads through a stage pipeline, a stage guide you write, and a drafter that prepares the next message for a person to approve and send.',
    requires: { connections: [], ai: 'byo' },
    databases: [
      {
        action: 'create',
        name: 'Leads',
        space: 'Lead Follow-up',
        fields: [
          { name: 'Source', type: 'select', options: [{ label: 'Referral' }, { label: 'Inbound' }, { label: 'Outbound' }, { label: 'Event' }, { label: 'Partner' }] },
          { name: 'Company', type: 'text' },
          { name: 'Contact Email', type: 'email' },
          // There is no phone field type: a phone number is text (as in the Agency CRM template).
          { name: 'Phone', type: 'text' },
          { name: 'Preferred Channel', type: 'select', options: [{ label: 'Email' }, { label: 'WhatsApp' }, { label: 'Phone' }] },
          // Ticked only when the lead has said yes to WhatsApp, 1:1. A checkbox is only as good as the person ticking it; it is not a legal record.
          { name: 'WhatsApp Consent', type: 'checkbox' },
          { name: 'Consent Note', type: 'text' },
          { name: 'Do Not Contact', type: 'checkbox' },
          // Edit per business: these are the sample studio's.
          {
            name: 'Interest',
            type: 'select',
            options: [{ label: 'Brand identity' }, { label: 'Website' }, { label: 'Packaging' }, { label: 'Illustration' }, { label: 'Other' }],
          },
          { name: 'Deal Value', type: 'number', config: { ...USD } },
          { name: 'Owner', type: 'user' },
          { name: 'Last Contact', type: 'date' },
          {
            // Declared after Last Contact (a formula is created in field order). days_between counts FROM the first date TO the second.
            name: 'Days Since Contact',
            type: 'formula',
            config: { expression: 'days_between({Last Contact}, today())', precision: 0 },
          },
          { name: 'Next Step', type: 'text' },
          { name: 'Next Step Date', type: 'date' },
          { name: 'Lost Reason', type: 'select', options: [{ label: 'Budget' }, { label: 'Timing' }, { label: 'Competitor' }, { label: 'Ghosted' }, { label: 'Bad fit' }] },
          { name: 'Notes', type: 'rich_text' },
        ],
      },
      {
        action: 'create',
        name: 'Follow-ups',
        space: 'Lead Follow-up',
        fields: [
          { name: 'Stage At Draft', type: 'select', options: stageOptions },
          { name: 'Channel', type: 'select', options: [{ label: 'Email' }, { label: 'WhatsApp' }] },
          { name: 'Subject', type: 'text' },
          { name: 'Draft', type: 'rich_text' },
          { name: 'Send After', type: 'date' },
          { name: 'Approved By', type: 'user' },
          { name: 'Sent On', type: 'date' },
          { name: 'Reviewer Note', type: 'text', config: { multiline: true } },
        ],
      },
      {
        action: 'create',
        name: 'Stage Guide',
        space: 'Lead Follow-up',
        fields: [
          { name: 'Stage', type: 'select', options: stageOptions },
          { name: 'Goal', type: 'text' },
          { name: 'Must Include', type: 'rich_text' },
          { name: 'Never Say', type: 'rich_text' },
          { name: 'Wait Days', type: 'number' },
          { name: 'Booking Link', type: 'url' },
          { name: 'Signature', type: 'text' },
        ],
      },
    ],
    // Follow-ups -> Leads. The Stage Guide is read by stage NAME, so it has no relation.
    relations: [{ from: 'Follow-ups', to: 'Leads', cardinality: 'one_to_many', from_field: 'Lead', to_field: 'Follow-ups' }],
    states: [
      {
        // The Agency CRM template's stages, then Not now. Red for Lost and never gold, as in Deal Desk: gold is the colour of an agent acting.
        database: 'Leads',
        field: 'Stage',
        options: [
          { label: 'New', color: 'gray', category: 'backlog' },
          { label: 'Contacted', color: 'blue', category: 'unstarted' },
          { label: 'Call Booked', color: 'purple', category: 'started' },
          { label: 'Proposal Sent', color: 'teal', category: 'started' },
          { label: 'Negotiating', color: 'orange', category: 'started' },
          { label: 'Won', color: 'green', category: 'completed' },
          { label: 'Lost', color: 'red', category: 'canceled' },
          { label: 'Not now', color: 'brown', category: 'canceled' },
        ],
      },
      {
        database: 'Follow-ups',
        field: 'Status',
        options: [
          { label: 'Drafted', color: 'gray', category: 'backlog' },
          { label: 'Ready for review', color: 'blue', category: 'unstarted' },
          { label: 'Approved', color: 'purple', category: 'started' },
          { label: 'Sent', color: 'green', category: 'completed' },
          { label: 'Skipped', color: 'brown', category: 'canceled' },
        ],
      },
    ],
    agents: [
      {
        name: 'Lead Follow-up Drafter',
        goal: 'When a lead enters a stage, draft the next message into a Follow-up record for a person to approve and send. Never send anything.',
        instructions: AGENT_INSTRUCTIONS,
        scopes: ['read', 'write'],
        approval_policy: ['email', 'outward'],
        target_databases: ['Leads', 'Follow-ups', 'Stage Guide'],
        // The prompt is not the mechanism: "never changes the lead, never marks a draft Sent, never edits the guide" is held by StoryOS. Any UPDATE
        // the agent makes to those three databases waits in the Approvals inbox; its own new Follow-up (the draft) is a create, so it is not held.
        write_gates: [
          { operations: ['update'], database: 'Leads' },
          { operations: ['update'], database: 'Follow-ups' },
          { operations: ['update'], database: 'Stage Guide' },
        ],
        skills: [],
        // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered).
        ai_mode: 'your_own_ai',
      },
    ],
    // One trigger per stage (a trigger binds one option of one field). Every one installs OFF (#1192): nothing is drafted until a person
    // switches the drafter on. Every one carries the condition "Do Not Contact is unchecked", which the CODE checks at wake time: a lead
    // marked Do Not Contact never wakes the drafter, and the skipped wake is listed (list_agent_wakes). The agent's instructions (rule 1)
    // still say the same thing, as the second line of defence for a run somebody starts by hand.
    triggers: STAGES.map((state_option) => ({
      agent: 'Lead Follow-up Drafter',
      database: 'Leads',
      state_field: 'Stage',
      state_option,
      human_gate: false,
      condition: { field: 'do_not_contact', op: 'eq' as const, value: false },
    })),
    derived_fields: [],
    views: [
      {
        database: 'Leads',
        name: 'Lead Pipeline',
        type: 'board',
        default: true,
        config: {
          group_by_field_id: fieldRef('Leads', 'Stage'),
          // Who, how much, how long since we spoke: what a person acts on at a glance. The grouped field is the column, so it is never listed.
          card_field_ids: [fieldRef('Leads', 'Company'), fieldRef('Leads', 'Deal Value'), fieldRef('Leads', 'Days Since Contact')],
        },
      },
      {
        // The approval queue: oldest first, so the message that has waited longest is at the top.
        database: 'Follow-ups',
        name: 'Ready for Review',
        type: 'table',
        default: true,
        config: {
          filters: { field: 'status', op: 'has', value: [optionRef('Follow-ups', 'Status', 'Ready for review')] },
          sorts: [{ field: 'created_at', direction: 'asc' }],
        },
      },
      {
        // More than a week since the last contact, and still open. Filters on the DATE (see the note at the top), sorted longest-quiet first.
        database: 'Leads',
        name: 'Going Quiet',
        type: 'table',
        config: {
          filters: { and: [{ field: 'last_contact', op: 'before', value: '$date:-7d' }, OPEN_STAGES] },
          sorts: [{ field: 'last_contact', direction: 'asc' }],
        },
      },
    ],
    automations: [
      {
        database: 'Leads',
        name: 'Notify on lead stage change',
        trigger: { type: 'record_updated', field_id: fieldRef('Leads', 'Stage') },
        actions: [{ type: 'notify_user', user: 'owner', message: 'Lead moved stage: {Name}. Run the drafter, or review its draft.' }],
        enabled: true,
      },
    ],
    // Invented people and businesses, each Lead and Follow-up titled "(sample)"; emails use the reserved .example domain.
    // Listed in the order a link needs: a record can only point at one listed before it.
    sample_records: [
      // The Stage Guide: STRUCTURE, not sample (`sample: false`), so "Remove sample data" leaves the drafter its instructions.
      ...(
        [
          ['New', 'First reply: thank them, ask one question, offer a way to book.', 'The booking link. One question about what they need.', undefined],
          ['Contacted', 'One gentle nudge, used only if there is no reply.', 'A way to say "not now" and be left alone.', 4],
          ['Call Booked', 'Confirm the call: time, what we will cover, one thing to prepare.', 'The call time. What happens on the call. One prep ask.', undefined],
          ['Proposal Sent', 'A covering note with the proposal, and a check-in for later.', 'What is in the proposal. An invitation to say what does not fit.', 5],
          ['Negotiating', 'Sum up what changed and what is still open.', 'What was agreed. What is still open. The next step.', undefined],
          ['Won', 'Thank them, and say what happens next.', 'What happens next and when.', undefined],
          ['Lost', 'One short, gracious close.', 'Thanks, and an optional question about what would have made the difference.', undefined],
          ['Not now', 'Check in on the date they named.', 'A reminder of what they asked about. An easy way to say no.', undefined],
        ] as const
      ).map(([stage, goal, mustInclude, waitDays]) => ({
        database: 'Stage Guide',
        sample: false,
        values: {
          name: stage,
          stage: optionRef('Stage Guide', 'Stage', stage),
          goal,
          must_include: blocks(mustInclude),
          never_say: blocks(NEVER_SAY),
          ...(waitDays !== undefined ? { wait_days: waitDays } : {}),
          signature: 'Your name, your studio',
        },
      })),
      {
        database: 'Leads',
        values: {
          name: 'Sofia Berg, Northfield Ceramics (sample)',
          stage: optionRef('Leads', 'Stage', 'New'),
          source: optionRef('Leads', 'Source', 'Inbound'),
          company: 'Northfield Ceramics',
          contact_email: 'sofia@northfield-ceramics.example',
          preferred_channel: optionRef('Leads', 'Preferred Channel', 'Email'),
          interest: optionRef('Leads', 'Interest', 'Brand identity'),
          owner: SAMPLE_ME,
          notes: blocks('Wrote in through the website asking about a new identity.'),
        },
      },
      {
        database: 'Leads',
        values: {
          name: 'Leo Hartmann, Harbour Yoga (sample)',
          stage: optionRef('Leads', 'Stage', 'Contacted'),
          source: optionRef('Leads', 'Source', 'Referral'),
          company: 'Harbour Yoga',
          contact_email: 'leo@harbour-yoga.example',
          phone: '+00 555 0101',
          preferred_channel: optionRef('Leads', 'Preferred Channel', 'WhatsApp'),
          whatsapp_consent: true,
          consent_note: 'Asked us to use WhatsApp on the intro call',
          interest: optionRef('Leads', 'Interest', 'Website'),
          owner: SAMPLE_ME,
          last_contact: sampleDate(-9),
        },
      },
      {
        database: 'Leads',
        values: {
          name: 'Marta Kowal, Olive & Thyme Deli (sample)',
          stage: optionRef('Leads', 'Stage', 'Call Booked'),
          source: optionRef('Leads', 'Source', 'Event'),
          company: 'Olive & Thyme Deli',
          contact_email: 'marta@olive-thyme-deli.example',
          preferred_channel: optionRef('Leads', 'Preferred Channel', 'Email'),
          interest: optionRef('Leads', 'Interest', 'Packaging'),
          owner: SAMPLE_ME,
          last_contact: sampleDate(-2),
          next_step: 'Intro call',
          next_step_date: sampleDate(2),
        },
      },
      {
        database: 'Leads',
        values: {
          name: 'Dr Kwame Osei, Brightwater Dental (sample)',
          stage: optionRef('Leads', 'Stage', 'Proposal Sent'),
          source: optionRef('Leads', 'Source', 'Outbound'),
          company: 'Brightwater Dental',
          contact_email: 'kwame@brightwater-dental.example',
          preferred_channel: optionRef('Leads', 'Preferred Channel', 'Email'),
          interest: optionRef('Leads', 'Interest', 'Website'),
          deal_value: 4800,
          owner: SAMPLE_ME,
          last_contact: sampleDate(-8),
          next_step: 'Check the proposal landed',
          notes: blocks('Proposal for the new site sent last week. Wants the booking page included.'),
        },
      },
      {
        database: 'Leads',
        values: {
          name: 'Priya Nair, Pine Street Books (sample)',
          stage: optionRef('Leads', 'Stage', 'Won'),
          source: optionRef('Leads', 'Source', 'Partner'),
          company: 'Pine Street Books',
          contact_email: 'priya@pine-street-books.example',
          preferred_channel: optionRef('Leads', 'Preferred Channel', 'Email'),
          interest: optionRef('Leads', 'Interest', 'Illustration'),
          owner: SAMPLE_ME,
          last_contact: sampleDate(-3),
        },
      },
      {
        database: 'Leads',
        values: {
          name: 'Tom Becker, Ridgeway Cycles (sample)',
          stage: optionRef('Leads', 'Stage', 'Lost'),
          source: optionRef('Leads', 'Source', 'Outbound'),
          company: 'Ridgeway Cycles',
          contact_email: 'tom@ridgeway-cycles.example',
          preferred_channel: optionRef('Leads', 'Preferred Channel', 'Email'),
          interest: optionRef('Leads', 'Interest', 'Brand identity'),
          lost_reason: optionRef('Leads', 'Lost Reason', 'Timing'),
          owner: SAMPLE_ME,
          last_contact: sampleDate(-40),
        },
      },
      {
        database: 'Leads',
        values: {
          name: 'Hana Sato, Tallow Candle Co. (sample)',
          stage: optionRef('Leads', 'Stage', 'Not now'),
          source: optionRef('Leads', 'Source', 'Referral'),
          company: 'Tallow Candle Co.',
          contact_email: 'hana@tallow-candle.example',
          preferred_channel: optionRef('Leads', 'Preferred Channel', 'Email'),
          interest: optionRef('Leads', 'Interest', 'Packaging'),
          owner: SAMPLE_ME,
          last_contact: sampleDate(-30),
          // "30 days after you install": the date they asked to be checked on.
          next_step: 'Check in about the candle labels',
          next_step_date: sampleDate(30),
        },
      },
      // Together the three Follow-ups show the whole review loop: waiting for review, approved, sent.
      {
        database: 'Follow-ups',
        values: {
          name: 'New: first reply (sample)',
          lead: [sampleRef('Leads', 'Sofia Berg, Northfield Ceramics (sample)')],
          stage_at_draft: optionRef('Follow-ups', 'Stage At Draft', 'New'),
          channel: optionRef('Follow-ups', 'Channel', 'Email'),
          subject: 'Your new identity for Northfield Ceramics',
          draft: blocks(
            'Hi Sofia, thanks for getting in touch about a new identity for Northfield Ceramics. One question before we talk: is this a full rebrand, or a refresh of what you have? If a call is easier, pick a time here: ⟦BOOKING LINK⟧.',
            'Ana, Fernhill Studio',
          ),
          status: optionRef('Follow-ups', 'Status', 'Ready for review'),
        },
      },
      {
        database: 'Follow-ups',
        values: {
          name: 'Call Booked: confirmation (sample)',
          lead: [sampleRef('Leads', 'Marta Kowal, Olive & Thyme Deli (sample)')],
          stage_at_draft: optionRef('Follow-ups', 'Stage At Draft', 'Call Booked'),
          channel: optionRef('Follow-ups', 'Channel', 'Email'),
          subject: 'Your call with Fernhill Studio',
          draft: blocks(
            'Hi Marta, you’re booked for ⟦CALL TIME⟧. We’ll cover the packaging range, your timeline and budget, and whether we’re the right fit. If you have photos of the current packs, send them before the call.',
            'Ana',
          ),
          status: optionRef('Follow-ups', 'Status', 'Approved'),
          approved_by: SAMPLE_ME,
        },
      },
      {
        database: 'Follow-ups',
        values: {
          name: 'Won: thank you (sample)',
          lead: [sampleRef('Leads', 'Priya Nair, Pine Street Books (sample)')],
          stage_at_draft: optionRef('Follow-ups', 'Stage At Draft', 'Won'),
          channel: optionRef('Follow-ups', 'Channel', 'Email'),
          subject: 'Thank you, Priya',
          draft: blocks(
            'Hi Priya, thank you. We’re glad to be working with you. Next, I’ll send a short kickoff questionnaire, and then we’ll book the first session.',
            'Ana',
          ),
          status: optionRef('Follow-ups', 'Status', 'Sent'),
          approved_by: SAMPLE_ME,
          sent_on: sampleDate(-3),
        },
      },
    ],
    skills: [],
    suggested_sources: [],
  },
};
