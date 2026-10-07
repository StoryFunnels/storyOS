/**
 * Template registry (MN-033) — the machine-readable docs/product/template-library.md.
 * Definitions live per category; this file assembles the registry + intents.
 */
import {
  agencyCrm,
  clientSpace,
  clientWork,
  contentPipeline,
  funnels,
  socialCalendar,
} from './definitions/agency';
import { calendarDatabase } from './definitions/calendar';
import { authorStudio, coachingPractice, consulting } from './definitions/creators';
import { devProject, soloDev } from './definitions/dev';
import {
  campaignsHq,
  customerJourney,
  eventPlanning,
  meetings,
  salesCrm,
  videoProduction,
} from './definitions/marketing';
import { orgChart, timeOff } from './definitions/people';
import {
  youtubeCommentsDatabase,
  youtubeMetricsDatabase,
  youtubeVideosDatabase,
} from './definitions/youtube';
import type { IntentDef, TemplateDef } from './types';

export const TEMPLATES: TemplateDef[] = [
  calendarDatabase,
  youtubeVideosDatabase,
  youtubeCommentsDatabase,
  youtubeMetricsDatabase,
  clientWork,
  clientSpace,
  agencyCrm,
  contentPipeline,
  socialCalendar,
  funnels,
  meetings,
  customerJourney,
  eventPlanning,
  videoProduction,
  campaignsHq,
  salesCrm,
  orgChart,
  timeOff,
  coachingPractice,
  consulting,
  authorStudio,
  devProject,
  soloDev,
];

/**
 * "What are you working on?" — each intent maps to a (template, install shape).
 *
 * #589 — every PACK-scope template maps to an intent here; nothing is added to
 * TEMPLATES without a matching entry going forward, so the signup/empty-state
 * quick-pick grid stays a real cross-section of the catalog instead of the
 * seven-of-eighteen it had drifted to.
 *
 * The five DATABASE-scope templates (calendar, the three youtube-* databases,
 * funnels) are deliberately excluded — they are single-database add-ons meant
 * to be dropped into an EXISTING space (Business Packs gallery → "Browse all
 * templates"), not a whole starter workspace a "what are you working on"
 * answer installs. Mapping one to an intent would be the actual bug: it would
 * hand a first-time user one bare database with nothing around it.
 */
export const INTENTS: IntentDef[] = [
  {
    id: 'agency',
    label: 'Running an agency',
    description: 'Clients, projects and a task system to run them.',
    template: 'client-work',
  },
  {
    id: 'new-client',
    label: 'Onboarding a new client',
    description: 'A dedicated space to share with the client — tasks, deliverables, requests.',
    template: 'client-space',
    asks_name: 'Client name',
    ends_with_invite: true,
  },
  {
    id: 'agency-crm',
    label: 'Managing an agency CRM',
    description: 'Clients, contacts, projects, tasks and invoices — the whole agency backbone, interlinked.',
    template: 'agency-crm',
  },
  {
    id: 'social-calendar',
    label: 'Planning social media content',
    description: 'Plan posts around calendar moments, across platforms, with an approval flow.',
    template: 'social-calendar',
  },
  {
    id: 'dev',
    label: 'Starting a dev project',
    description: 'Issues with a Triage inbox, sprints and releases.',
    template: 'dev-project',
  },
  {
    id: 'solo-dev',
    label: 'Shipping as a solo developer',
    description: 'Issues + releases, zero ceremony — for shipping on vibes and a changelog.',
    template: 'solo-dev',
  },
  {
    id: 'blog',
    label: 'Launching a blog or content engine',
    description: 'An editorial pipeline tied to campaigns.',
    template: 'content-pipeline',
  },
  {
    id: 'book',
    label: 'Writing a book',
    description: 'Manuscript board, research notes and launch tasks.',
    template: 'author-studio',
  },
  {
    id: 'coaching',
    label: 'Running a coaching practice',
    description: 'Clients, programs, sessions and action items.',
    template: 'coaching-practice',
  },
  {
    id: 'consulting',
    label: 'Consulting engagements',
    description: 'Proposal pipeline, engagements and delivery.',
    template: 'consulting',
  },
  {
    id: 'meetings',
    label: 'Running meetings & action items',
    description: 'Capture notes for any meeting and make sure action items actually get done.',
    template: 'meetings',
  },
  {
    id: 'customer-journey',
    label: 'Mapping the customer journey',
    description: 'Map every stage of the customer experience and mine it for opportunities.',
    template: 'customer-journey',
  },
  {
    id: 'event-planning',
    label: 'Planning an event',
    description: 'Tasks, budget and timeline for events that actually run on time.',
    template: 'event-planning',
  },
  {
    id: 'video-production',
    label: 'Producing video content',
    description: 'From idea to published: scripts, shoots, edits and costs in one pipeline.',
    template: 'video-production',
  },
  {
    id: 'campaigns-hq',
    label: 'Running marketing campaigns',
    description: 'Brief, launch and measure marketing campaigns — objectives, audiences and metrics in one place.',
    template: 'campaigns-hq',
  },
  {
    id: 'sales-crm',
    label: 'Running a sales pipeline',
    description: 'Accounts, contacts and a real opportunity pipeline — lighter than a CRM, stronger than a spreadsheet.',
    template: 'sales-crm',
  },
  {
    id: 'org-chart',
    label: 'Building an org chart',
    description: 'Teams, people and reporting lines — the company directory that stays current.',
    template: 'org-chart',
  },
  {
    id: 'time-off',
    label: 'Tracking time off',
    description: 'Vacations, sick leave and overtime — who is out, when, and is it approved.',
    template: 'time-off',
  },
];
