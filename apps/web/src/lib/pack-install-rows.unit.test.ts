import { describe, expect, it } from 'vitest';
import {
  approvalSentence,
  buildInstallRows,
  notNew,
  packSpaceName,
  sampleRecordCount,
  type PreviewRowItem,
  type RowManifest,
} from './pack-install-rows';

const manifest: RowManifest = {
  databases: [
    { name: 'Tickets', space: 'Support Inbox' },
    { name: 'Contacts', space: 'Support Inbox' },
  ],
  views: [{ database: 'Tickets', name: 'Board' }],
  automations: [{ database: 'Tickets', name: 'Notify on status change' }],
  agents: [
    {
      name: 'Triage',
      goal: 'Reads each new ticket and suggests Type and Priority. Then waits.',
      approval_policy: ['email', 'delete'],
    },
  ],
  sample_records: [{}, {}],
};
const item = (
  name: string,
  action: PreviewRowItem['action'] = 'create',
  over: Partial<PreviewRowItem> = {},
): PreviewRowItem => ({ name, action, ...over });
const preview = (over: Partial<Parameters<typeof buildInstallRows>[0]> = {}) => ({
  databases: [item('Tickets')],
  views: [item('Tickets.Board')],
  automations: [item('Tickets.Notify on status change')],
  agents: [item('Triage')],
  ...over,
});

describe('buildInstallRows (#978)', () => {
  it('speaks in a person’s words: "Board" with "view of Tickets", not the API label', () => {
    const rows = buildInstallRows(preview(), manifest);
    const board = rows.find((r) => r.kind === 'view')!;
    expect(board.name).toBe('Board');
    expect(board.sub).toBe('view of Tickets');
    expect(board.key).toBe('Tickets.Board'); // resolutions stay keyed by the API's label
    expect(rows.find((r) => r.kind === 'automation')!.name).toBe('Notify on status change');
    expect(rows.find((r) => r.kind === 'automation')!.sub).toBe('automation · on Tickets');
  });

  it('orders databases, views, automations, agents', () => {
    expect(buildInstallRows(preview(), manifest).map((r) => r.kind)).toEqual([
      'database',
      'view',
      'automation',
      'agent',
    ]);
  });

  it('an all-new pack has no row notes at all (the dialog says so once)', () => {
    const rows = buildInstallRows(preview(), manifest);
    expect(rows.every((r) => r.note === null)).toBe(true);
    expect(notNew(rows)).toEqual([]);
  });

  it('the agent row says what it does and that it works through the person’s own AI, and names its gates only if it has them', () => {
    const agent = buildInstallRows(preview(), manifest).find((r) => r.kind === 'agent')!;
    expect(agent.sub).toBe(
      'agent · Reads each new ticket and suggests Type and Priority. It works through your own AI. It asks before sending email and deleting.',
    );
    const noGates = buildInstallRows(preview(), {
      ...manifest,
      agents: [{ name: 'Triage', goal: 'Reads tickets', approval_policy: [] }],
    }).find((r) => r.kind === 'agent')!;
    expect(noGates.sub).not.toMatch(/asks before/);
    expect(approvalSentence([])).toBeNull();
  });

  it('a reused database carries a note built from its gains; a new one does not', () => {
    const rows = buildInstallRows(
      preview({
        databases: [
          item('Tickets', 'reuse', {
            gains: {
              fields: [{ name: 'Health', type: 'select' }],
              options: [],
              views: [],
              not_applied: [],
            },
          }),
          item('Contacts'),
        ],
      }),
      manifest,
    );
    expect(rows[0]!.note).toBe('Already in your workspace — kept as it is. Adds the Health field.');
    expect(rows[1]!.note).toBeNull();
    expect(notNew(rows)).toHaveLength(1);
  });

  it('a database name collision is not new and says nothing of the person’s is removed', () => {
    const rows = buildInstallRows(preview({ databases: [item('Tickets', 'collision')] }), manifest);
    expect(rows[0]!.action).toBe('collision');
    expect(rows[0]!.note).toMatch(/nothing in it is removed/);
  });

  it('keeps an unmatched view label rather than inventing a name', () => {
    const rows = buildInstallRows(preview({ views: [item('Ghost.Board')] }), manifest);
    expect(rows.find((r) => r.kind === 'view')!.name).toBe('Ghost.Board');
    expect(rows.find((r) => r.kind === 'view')!.sub).toBe('view');
  });

  it('an agent this pack installed before gets its note from agentEffect, not here', () => {
    const rows = buildInstallRows(
      preview({
        agents: [item('Triage', 'reuse', { agent_update: { status: 'unchanged', changed_fields: [] } })],
      }),
      manifest,
    );
    expect(rows.find((r) => r.kind === 'agent')!.note).toBeNull();
  });
});

describe('the space and samples come from the manifest', () => {
  it('names the one space the pack adds, and none when it spans several', () => {
    expect(packSpaceName(manifest)).toBe('Support Inbox');
    expect(
      packSpaceName({
        databases: [
          { name: 'A', space: 'X' },
          { name: 'B', space: 'Y' },
        ],
      }),
    ).toBeNull();
    expect(packSpaceName(undefined)).toBeNull();
  });
  it('counts sample records, zero when there are none', () => {
    expect(sampleRecordCount(manifest)).toBe(2);
    expect(sampleRecordCount({})).toBe(0);
  });
});
