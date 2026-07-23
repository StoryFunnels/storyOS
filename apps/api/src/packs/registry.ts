import { fieldRef, optionRef } from '@storyos/schemas';
import type { PackPublicPreview, PackRegistryEntry } from '@storyos/schemas';
import { STARTER_PACKS } from './starter-packs';

/**
 * The built-in Business Pack gallery (MN-219 / #161).
 *
 * Hand-authored manifests rather than something exported from a live
 * workspace, for the same reason the starter templates in
 * `templates/definitions.ts` are hand-authored: there is no "reference"
 * workspace to export from yet, and a pack is meant to be readable — a person
 * deciding whether to install it should be able to open this file and see
 * exactly what they'd get. Authored directly against `packManifestSchema`
 * (not round-tripped through `PacksService.export`), using the same
 * `$field:`/`$option:` ref helpers export itself uses, so it exercises the
 * ordinary install path rather than a special "built-in" one.
 */
export const PACK_REGISTRY: PackRegistryEntry[] = [
  ...STARTER_PACKS,
  {
    slug: 'support-inbox',
    name: 'Support Inbox',
    summary:
      'A lightweight support ticket tracker: a New → In Progress → Resolved workflow, a board view, ' +
      'a status-change notification, and a Triage agent that reads new tickets.',
    highlights: [
      'Tickets database with Description and Requester Email',
      'Board view grouped by Status',
      'Notifies you when a ticket’s status changes',
      'A "Triage" agent bound to new tickets (your own AI over MCP)',
    ],
    manifest: {
      format_version: 1,
      slug: 'support-inbox',
      name: 'Support Inbox',
      version: '1.0.0',
      summary: 'A lightweight support ticket tracker with a workflow, a board view and a triage agent.',
      scenario: 'pack',
      requires: { connections: ['email'], ai: 'byo' },
      databases: [
        {
          action: 'create',
          name: 'Tickets',
          space: 'Support',
          fields: [
            { name: 'Description', type: 'rich_text' },
            { name: 'Requester Email', type: 'email' },
          ],
        },
      ],
      relations: [],
      states: [
        {
          database: 'Tickets',
          field: 'Status',
          options: [
            { label: 'New', color: 'blue' },
            { label: 'In Progress', color: 'gold' },
            { label: 'Resolved', color: 'green' },
          ],
        },
      ],
      agents: [
        {
          name: 'Triage',
          goal: 'Read new support tickets and draft a first response.',
          instructions:
            'Summarize the ticket and suggest a next step. Never contact the requester without approval.',
          scopes: ['read', 'write'],
          approval_policy: ['email', 'outward'],
          target_databases: ['Tickets'],
          skills: [],
        },
      ],
      triggers: [
        {
          agent: 'Triage',
          database: 'Tickets',
          state_field: 'Status',
          state_option: 'New',
          human_gate: false,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Tickets',
          name: 'Board',
          type: 'board',
          config: { group_by_field_id: fieldRef('Tickets', 'Status') },
        },
      ],
      automations: [
        {
          database: 'Tickets',
          name: 'Notify on status change',
          trigger: { type: 'record_updated', field_id: fieldRef('Tickets', 'Status') },
          actions: [
            { type: 'notify_user', user: '@me', message: 'A ticket’s status changed.' },
          ],
          enabled: true,
        },
      ],
      sample_records: [
        {
          database: 'Tickets',
          // Sample record values are keyed by api_name (a slugified display
          // name), not the display name itself — `status`, not `Status`.
          values: { name: 'Cannot log in', status: optionRef('Tickets', 'Status', 'New') },
        },
      ],
      skills: [],
    },
  },
];

/**
 * The shallow, public-safe shape of a registry entry (#272) — names only, no
 * ref-encoded configs. Used by the unauthenticated `public/packs` routes so a
 * pack link works for someone who has never logged in; see
 * `packPublicPreviewSchema`'s doc for why this isn't just the manifest.
 */
export function toPublicPreview(entry: PackRegistryEntry): PackPublicPreview {
  const { manifest } = entry;
  return {
    slug: entry.slug,
    name: entry.name,
    summary: entry.summary,
    highlights: entry.highlights,
    requires: manifest.requires,
    contents: {
      databases: manifest.databases.map((d) => d.name),
      views: manifest.views.map((v) => v.name),
      automations: manifest.automations.map((a) => a.name),
      agents: manifest.agents.map((a) => a.name),
      skills: manifest.skills.map((s) => s.name),
    },
  };
}
