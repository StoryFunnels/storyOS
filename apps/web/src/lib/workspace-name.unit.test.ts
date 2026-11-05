import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { updateWorkspaceSchema } from '@storyos/schemas';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_NAME_MAX, workspaceNameCacheKeys, workspaceNameDraft } from './workspace-name';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the workspace name draft (#1186)', () => {
  it('trims what it sends and enables Save only for a different name', () => {
    expect(workspaceNameDraft('  Acme Co  ', 'JCM Agency')).toMatchObject({ value: 'Acme Co', error: null, canSave: true });
    expect(workspaceNameDraft('JCM Agency', 'JCM Agency').canSave).toBe(false);
    expect(workspaceNameDraft('  JCM Agency ', 'JCM Agency').canSave).toBe(false);
  });

  it('refuses empty and whitespace-only names with a sentence, and sends nothing', () => {
    for (const raw of ['', '   ', '\n\t']) {
      expect(workspaceNameDraft(raw, 'JCM Agency')).toMatchObject({ value: null, canSave: false, error: 'A workspace needs a name.' });
    }
  });

  it('refuses a name over the cap, saying by how much, and keeps exactly the cap', () => {
    const over = workspaceNameDraft('x'.repeat(WORKSPACE_NAME_MAX + 3), 'JCM Agency');
    expect(over).toMatchObject({ value: null, canSave: false });
    expect(over.error).toBe('3 too many characters. A name can be up to 100.');
    expect(workspaceNameDraft('x'.repeat(WORKSPACE_NAME_MAX), 'JCM Agency')).toMatchObject({ error: null, canSave: true });
  });

  it('agrees with the server schema on every boundary case', () => {
    for (const raw of ['', '  ', 'a', ' a ', 'x'.repeat(100), 'x'.repeat(101), ` ${'x'.repeat(100)} `]) {
      const server = updateWorkspaceSchema.safeParse({ name: raw }).success;
      expect(workspaceNameDraft(raw, 'other').value !== null, `server and web disagree on ${JSON.stringify(raw.slice(0, 8))}`).toBe(server);
    }
  });
});

describe('where a renamed workspace shows (#1186 AC1)', () => {
  it('refreshes the workspace record AND the workspace list', () => {
    expect(workspaceNameCacheKeys('w1')).toEqual([['workspace', 'w1'], ['workspaces']]);
  });

  it('the update mutation invalidates exactly those keys, and the readers of the name sit on them', () => {
    expect(src('./queries.ts')).toContain('workspaceNameCacheKeys(ws)');
    // The readers: the sidebar header and switcher, the home greeting, Settings home and Connect your AI read `useWorkspace`
    // (['workspace', ws]); the switcher's list, the Settings signals and the API tokens page read ['workspaces'].
    expect(src('./queries.ts')).toMatch(/queryKey: \['workspace', ws\]/);
    expect(src('../components/sidebar.tsx')).toMatch(/queryKey: \['workspaces'\]/);
    expect(src('../components/settings/use-settings-signals.ts')).toMatch(/queryKey: \['workspaces'\]/);
  });

  it('the General page saves through the shared draft, not its own rules', () => {
    const page = src('../app/w/[ws]/settings/general/page.tsx');
    expect(page).toContain('workspaceNameDraft(');
    expect(page).not.toMatch(/\.length > 100|\.length\s*>\s*WORKSPACE_NAME_MAX/);
  });
});
