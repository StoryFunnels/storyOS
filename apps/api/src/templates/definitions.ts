/**
 * Template registry (MN-033) — the machine-readable docs/product/template-library.md.
 * Definitions live per category; this file assembles the registry + intents.
 */
import { agencyCrm, clientSpace, clientWork, contentPipeline, funnels, socialCalendar } from './definitions/agency';
import { authorStudio, coachingPractice, consulting } from './definitions/creators';
import { devProject, soloDev } from './definitions/dev';
import { campaignsHq, customerJourney, eventPlanning, meetings, salesCrm, videoProduction } from './definitions/marketing';
import { orgChart, timeOff } from './definitions/people';
import type { IntentDef, TemplateDef } from './types';

export const TEMPLATES: TemplateDef[] = [
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

/** "What are you working on?" — each intent maps to a (template, install shape). */
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
    id: 'dev',
    label: 'Starting a dev project',
    description: 'Issues with a Triage inbox, sprints and releases.',
    template: 'dev-project',
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
];
