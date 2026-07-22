import { z } from 'zod';

/**
 * #40 — the Skills framework: named, reusable instruction+workflow bundles for
 * the StoryOS agent (cf. Linear "save this conversation as a skill" + Agent
 * personalization; ADR-0010 is the agent engine this rides on top of).
 *
 * Two design principles, both load-bearing for the shape below:
 *
 *   NOT FROM SCRATCH — a skill is authored against a fixed schema (name,
 *   description, when-to-use, instructions, examples, allowed tools) and
 *   SKILL_TEMPLATES gives every author a starting scaffold rather than a blank
 *   box. "Save this chat as a skill" (#39) is a second on-ramp into the same
 *   schema — not built here (no chat composer exists yet), but nothing about
 *   this shape blocks it: it would just be another producer of
 *   `createSkillSchema` input, with `source_template: 'chat'`.
 *
 *   PORTABLE / RE-USABLE ELSEWHERE — every field here is plain text or a plain
 *   array; nothing is StoryOS-internal (no record ids, no field ids). That is
 *   what lets a skill export as Markdown / a Claude-Skill SKILL.md / ChatGPT
 *   custom instructions and mean the same thing pasted into a different tool
 *   entirely (see skill-export.ts in the API for the three renderers).
 *
 * MCP exposure (#41) is a separate ticket. Nothing here precludes it: `allowed
 * tools` is already the exact vocabulary an MCP tool allowlist would need, and
 * the run endpoint is additive, not a rework.
 */

export const skillVisibilitySchema = z.enum(['personal', 'shared']);
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>;

/** One example the author gives future callers (and, on export, the reader). */
export const skillExampleSchema = z.object({
  input: z.string().min(1).max(2000),
  output: z.string().min(1).max(4000),
});
export type SkillExample = z.infer<typeof skillExampleSchema>;

const nameSchema = z.string().min(1).max(100);
const descriptionSchema = z.string().min(1).max(500);
const whenToUseSchema = z.string().min(1).max(1000);
const instructionsSchema = z.string().min(1).max(20_000);
const allowedToolSchema = z.string().min(1).max(100);

/** POST body — create a skill. `source_template` is provenance only (which
 * scaffold it started from, or `chat` once #39 lands); it changes nothing
 * about validation. */
export const createSkillSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  when_to_use: whenToUseSchema,
  instructions: instructionsSchema,
  examples: z.array(skillExampleSchema).max(20).default([]),
  allowed_tools: z.array(allowedToolSchema).max(50).default([]),
  visibility: skillVisibilitySchema.default('personal'),
  source_template: z.string().max(100).optional(),
});
export type CreateSkillInput = z.infer<typeof createSkillSchema>;

/** PATCH body — every field optional, same validation per-field as create. */
export const updateSkillSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  when_to_use: whenToUseSchema.optional(),
  instructions: instructionsSchema.optional(),
  examples: z.array(skillExampleSchema).max(20).optional(),
  allowed_tools: z.array(allowedToolSchema).max(50).optional(),
  visibility: skillVisibilitySchema.optional(),
});
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

/** The client-safe read shape — a row of the skills table, plus whether the
 * requester may edit it (owner-only, regardless of visibility). */
export const skillSummarySchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  owner_id: z.string(),
  visibility: skillVisibilitySchema,
  name: nameSchema,
  description: descriptionSchema,
  when_to_use: whenToUseSchema,
  instructions: instructionsSchema,
  examples: z.array(skillExampleSchema),
  allowed_tools: z.array(allowedToolSchema),
  source_template: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_run_status: z.enum(['ok', 'error']).nullable(),
  editable: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

/** A starting scaffold offered by the "new skill" flow — the framework side of
 * "not from scratch". Deliberately just data: the web client renders these as
 * a picker and pre-fills `createSkillSchema`'s fields, `source_template` set to
 * the template's `id`. */
export const skillTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  when_to_use: z.string(),
  instructions: z.string(),
  examples: z.array(skillExampleSchema),
  allowed_tools: z.array(z.string()),
});
export type SkillTemplate = z.infer<typeof skillTemplateSchema>;

/** Portable export formats (the ticket's second principle). `claude_skill`
 * follows the emerging Agent Skills on-disk convention: a SKILL.md whose
 * frontmatter is just `name` + `description` (the two fields a skill picker
 * matches against) and whose body carries everything else in plain prose. */
export const skillExportFormatSchema = z.enum(['markdown', 'claude_skill', 'chatgpt']);
export type SkillExportFormat = z.infer<typeof skillExportFormatSchema>;

export const skillExportSchema = z.object({
  format: skillExportFormatSchema,
  /** Suggested filename for the exported content, e.g. `SKILL.md`. */
  filename: z.string(),
  content: z.string(),
});
export type SkillExport = z.infer<typeof skillExportSchema>;

/** One step of a manual skill run — same shape as the agents engine's
 * `AgentStep` (ADR-0010 §3), duplicated here rather than imported: this
 * package is framework-agnostic, and a run step is plain data regardless of
 * which engine produced it. */
export const skillRunStepSchema = z.object({
  tool: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
});
export type SkillRunStep = z.infer<typeof skillRunStepSchema>;

export const skillRunClassSchema = z.enum(['non_ai', 'your_own_ai', 'storyos_ai']);
export type SkillRunClass = z.infer<typeof skillRunClassSchema>;

export const skillRunResultSchema = z.object({
  run_class: skillRunClassSchema,
  steps: z.array(skillRunStepSchema),
  ran_at: z.string(),
});
export type SkillRunResult = z.infer<typeof skillRunResultSchema>;

/**
 * The starter scaffolds (NOT FROM SCRATCH, AC #2). Deliberately few and
 * StoryOS-shaped — a workspace's Agents/Automations database, records, and
 * fields all have this same "start from a small, real example" texture (see
 * architect-proposer.ts's scenario library). A blank-canvas option is simply
 * `POST /skills` with no `source_template`.
 */
export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: 'lead-triage-reply',
    name: 'Lead triage reply drafter',
    description: 'Reads a new lead record and drafts a first-touch reply for a human to review.',
    when_to_use:
      'When a new record lands in a Leads-shaped database and someone needs a fast, on-brand ' +
      'first reply drafted for them to edit and send — not sent automatically.',
    instructions:
      '1. Read the record\'s name, company, and any notes/message field.\n' +
      '2. Draft a short (3-5 sentence), friendly first-touch reply that acknowledges what they ' +
      'asked for and proposes a concrete next step (a call, a doc, a demo).\n' +
      '3. Never invent pricing, availability, or commitments the record does not support.\n' +
      '4. Leave the draft for a human to review — never send it unattended.',
    examples: [
      {
        input: 'Lead: Priya Shah, Acme Robotics — "Can we get a demo of the pricing tiers?"',
        output:
          'Hi Priya — thanks for reaching out! Happy to walk Acme Robotics through the pricing ' +
          'tiers. Do you have 20 minutes this week for a quick demo? I can also send over a ' +
          'one-pager first if that is easier to share internally.',
      },
    ],
    allowed_tools: ['records.read'],
  },
  {
    id: 'weekly-digest',
    name: 'Weekly status digest',
    description: 'Summarizes what changed across a database this week into one short digest.',
    when_to_use:
      'When a team wants a standing weekly summary of state changes, new records, and overdue ' +
      'items on a given database, instead of scrolling the full history.',
    instructions:
      '1. List records created or moved to a new state in the last 7 days.\n' +
      '2. Group by state; call out anything that has sat in a non-terminal state longer than 7 days.\n' +
      '3. Keep the whole digest under 200 words — this is a skim, not a report.\n' +
      '4. End with the single most overdue item, named explicitly.',
    examples: [],
    allowed_tools: ['records.read', 'databases.read'],
  },
  {
    id: 'support-reply-drafter',
    name: 'Support reply drafter',
    description: 'Drafts a reply to an inbound support record from its notes and history.',
    when_to_use:
      'When a support/ticket-shaped record comes in and a human wants a drafted reply to start ' +
      'from rather than a blank composer.',
    instructions:
      '1. Read the ticket description and any prior comments on the record.\n' +
      '2. If the issue matches something already answered on the record\'s history, draft a reply ' +
      'reusing that resolution.\n' +
      '3. If it does not, draft a reply asking the one clarifying question that would unblock it.\n' +
      '4. Keep the tone calm and specific; never promise a fix timeline.',
    examples: [],
    allowed_tools: ['records.read', 'comments.read'],
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'Start from an empty skill — for when none of the scaffolds fit.',
    when_to_use: '',
    instructions: '',
    examples: [],
    allowed_tools: [],
  },
];
