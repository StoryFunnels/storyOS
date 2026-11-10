import { describe, expect, it } from 'vitest';
import {
  approvalSentence,
  buildInstallRows,
  fieldLabel,
  fieldsLine,
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
        agents: [
          item('Triage', 'reuse', { agent_update: { status: 'unchanged', changed_fields: [] } }),
        ],
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

describe('database rows name their fields (ticket #1245)', () => {
  it('fieldsLine lists up to max, then +N more', () => {
    expect(fieldsLine(['Status', 'Assignee'], 3)).toBe('Status, Assignee');
    expect(fieldsLine(['A', 'B', 'C'], 3)).toBe('A, B, C'); // exactly max: no "+0 more"
    expect(fieldsLine(['A', 'B', 'C', 'D', 'E'], 3)).toBe('A, B, C, +2 more');
    expect(fieldsLine([], 3)).toBe('');
  });

  it('a database row reads "database · fields"; no fields in the manifest keeps plain "database"', () => {
    const m: RowManifest = {
      databases: [
        {
          name: 'Tickets',
          fields: [{ name: 'Status' }, { name: 'Assignee' }, { name: 'Due date' }],
        },
        { name: 'Contacts' },
      ],
    };
    const rows = buildInstallRows(preview({ databases: [item('Tickets'), item('Contacts')] }), m);
    expect(rows[0]!.sub).toBe('database · Status, Assignee, Due date');
    expect(rows[1]!.sub).toBe('database');
  });

  it('a long field list truncates on the row', () => {
    const fields = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) => ({ name }));
    const rows = buildInstallRows(preview(), { databases: [{ name: 'Tickets', fields }] });
    expect(rows[0]!.sub).toBe('database · A, B, C, D, E, F, +2 more');
  });

  const opts = (...l: string[]) => l.map((label) => ({ label }));
  const sub = (m: RowManifest) => buildInstallRows(preview(), m)[0]!.sub;

  it('lists a select/state field’s options, and a range when there are many', () => {
    expect(
      sub({
        databases: [
          {
            name: 'Tickets',
            fields: [{ name: 'Labels', options: opts('Bug', 'Feature') }, { name: 'Lead' }],
          },
        ],
        states: [
          {
            database: 'Tickets',
            field: 'State',
            options: opts(
              'Triage',
              'Backlog',
              'To Do',
              'In Progress',
              'In Review',
              'Done',
              'Canceled',
            ),
          },
        ],
      }),
    ).toBe('database · State (Triage → Canceled), Labels (Bug, Feature), Lead');
    expect(
      fieldLabel(
        'State',
        opts('A', 'B', 'C', 'D', 'E', 'F').map((o) => o.label),
      ),
    ).toBe('State (A, B, C, D, E, F)');
    expect(fieldLabel('Status', [])).toBe('Status');
  });

  const links = (m: RowManifest) => buildInstallRows(preview(), m)[0]!.links;

  it('relations go on their OWN line, not in the fields line; a to-side name is not added', () => {
    const m: RowManifest = {
      databases: [{ name: 'Tickets', fields: [{ name: 'Title' }] }],
      relations: [
        { from: 'Tickets', to: 'Projects', from_field: 'Project', to_field: 'Tickets' },
        { from: 'Projects', to: 'Tickets', from_field: 'Owner ticket', to_field: 'Projects' },
      ],
    };
    expect(sub(m)).toBe('database · Title');
    expect(links(m)).toBe('Links to Project');
  });

  it('a database with only relations shows only the Links line (sub stays bare "database")', () => {
    const m: RowManifest = {
      databases: [{ name: 'Tickets' }],
      relations: [
        { from: 'Tickets', to: 'Projects', from_field: 'Project', to_field: 'Tickets' },
        { from: 'Tickets', to: 'Sprints', from_field: 'Sprint', to_field: 'Tickets' },
      ],
    };
    expect(sub(m)).toBe('database');
    expect(links(m)).toBe('Links to Project, Sprint');
  });

  it('a database with no relations has no Links line, and non-database rows never do', () => {
    expect(links({ databases: [{ name: 'Tickets', fields: [{ name: 'Title' }] }] })).toBeNull();
    const rows = buildInstallRows(preview(), {
      databases: [{ name: 'Tickets' }],
      relations: [{ from: 'Tickets', from_field: 'Project' }],
    });
    expect(rows.slice(1).every((r) => r.links === null)).toBe(true);
  });

  it('derived fields (outside fields/states/relations) are never listed', () => {
    const m = {
      databases: [{ name: 'Tickets', fields: [{ name: 'Title' }] }],
      derived_fields: [{ database: 'Tickets', name: 'Open count', type: 'rollup' }],
      relations: [{ from: 'Tickets', from_field: 'Project' }],
    } as RowManifest;
    expect(sub(m)).toBe('database · Title');
    expect(links(m)).toBe('Links to Project');
  });

  it('the cap and +N count plain/state fields only; relations never consume the cap and are never cut', () => {
    const fields = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name }));
    const m: RowManifest = {
      databases: [{ name: 'Tickets', fields }],
      relations: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'].map((from_field) => ({
        from: 'Tickets',
        from_field,
      })),
    };
    expect(sub(m)).toBe('database · A, B, C, D, E'); // 5 fields + 7 relations: no "+N more"
    expect(links(m)).toBe('Links to R1, R2, R3, R4, R5, R6, R7');
    const eight = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) => ({ name }));
    expect(sub({ ...m, databases: [{ name: 'Tickets', fields: eight }] })).toBe(
      'database · A, B, C, D, E, F, +2 more',
    );
  });
});
