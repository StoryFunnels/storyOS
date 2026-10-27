import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  confirmRemoveCalendarMapping,
  confirmRemoveMember,
  confirmRemovePhoto,
  confirmRevokeInvite,
  confirmRevokeSession,
  confirmRevokeToken,
  confirmRoleChange,
  confirmToggleWebhook,
} from './settings-confirmations';

const page = (rel: string) => readFileSync(fileURLToPath(new URL(`../app/w/[ws]/settings/${rel}`, import.meta.url)), 'utf8');

describe('what each consequential Settings action asks (#1093)', () => {
  it('names who or what is affected, and the effect, in every dialog', () => {
    expect(confirmRoleChange('Maya Cole', 'member', 'guest')).toMatchObject({ title: 'Change Maya Cole to Guest?' });
    expect(confirmRoleChange('Maya Cole', 'member', 'guest').message).toContain('Maya Cole goes from Member to Guest');
    expect(confirmRemoveMember('Maya Cole').message).toContain('Maya Cole loses access to this workspace right away');
    expect(confirmRevokeInvite('maya@example.com').title).toContain('maya@example.com');
    expect(confirmRevokeInvite('maya@example.com').message).toContain('invite link stops working');
    expect(confirmRevokeSession('Chrome on macOS', '10.0.0.4').title).toContain('Chrome on macOS');
    expect(confirmRevokeSession('Chrome on macOS', '10.0.0.4').message).toContain('10.0.0.4');
    expect(confirmRevokeToken('CI key', 'Acme').message).toContain('Acme');
    expect(confirmToggleWebhook('https://hooks.example.com/x', false).message).toContain('https://hooks.example.com/x');
    expect(confirmRemoveCalendarMapping('Tasks', 'Team calendar').title).toBe('Stop syncing Tasks with Team calendar?');
    expect(confirmRemoveCalendarMapping('Tasks', 'Team calendar').message).toContain('Events already on the calendar stay');
    expect(confirmRemovePhoto().message).toContain('initials');
  });

  it('a role change says it plainly in the three directions that matter: off admin, onto admin, and between member and guest', () => {
    const demote = confirmRoleChange('Maya Cole', 'admin', 'member');
    expect(demote.message).toBe('Maya Cole stops being an admin and becomes a member. They lose access to the admin settings.');
    expect(demote.danger).toBe(true);
    const promote = confirmRoleChange('Maya Cole', 'member', 'admin');
    expect(promote.message).toContain('Maya Cole becomes an admin.');
    expect(promote.message).toContain('admin settings');
    expect(promote.danger).toBe(false);
    expect(confirmRoleChange('Maya Cole', 'guest', 'member').message).toContain('cannot open the admin settings');
  });

  it('removing things is danger-styled; enabling a webhook is not, disabling it is', () => {
    for (const c of [confirmRemoveMember('A'), confirmRevokeInvite('a@b.c'), confirmRevokeSession('d', 'ip'), confirmRevokeToken('t', 'w'), confirmRemovePhoto(), confirmRemoveCalendarMapping('d', 'c')]) {
      expect(c.danger, c.title).toBe(true);
    }
    expect(confirmToggleWebhook('u', true).danger).toBe(false);
    expect(confirmToggleWebhook('u', false).danger).toBe(true);
  });

  it('every dialog has a distinct confirm label that is a verb, never "OK" or a bare "Confirm"', () => {
    const labels = [
      confirmRoleChange('A', 'member', 'guest'), confirmRemoveMember('A'), confirmRevokeInvite('a@b.c'), confirmRemovePhoto(), confirmRevokeSession('d', 'ip'),
      confirmRevokeToken('t', 'w'), confirmToggleWebhook('u', true), confirmToggleWebhook('u', false), confirmRemoveCalendarMapping('d', 'c'),
    ].map((c) => c.confirmLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l).not.toMatch(/^(ok|confirm|yes)$/i);
  });

  it('each of the eight actions awaits the dialog BEFORE it calls its mutation, so Cancel changes nothing', () => {
    const cases: Array<[string, RegExp]> = [
      ['account/page.tsx', /if \(!\(await confirm\(confirmRemovePhoto\(\)\)\)\) return;\s*await fetch\(`\$\{API_URL\}\/api\/v1\/users\/me\/avatar`/],
      ['account/page.tsx', /if \(await confirm\(confirmRevokeSession\([\s\S]*?\)\)\) revoke\.mutate\(s\.token\)/],
      ['members/page.tsx', /if \(await confirm\(confirmRoleChange\([^;]*\)\) updateMember\.mutate/],
      ['members/page.tsx', /if \(await confirm\(confirmRemoveMember\(member\.user\.name\)\)\) removeMember\.mutate\(member\.id\)/],
      ['members/page.tsx', /if \(await confirm\(confirmRevokeInvite\(invite\.email\)\)\) revokeInvite\.mutate\(invite\.id\)/],
      ['api/page.tsx', /: await confirm\(confirmRevokeToken\(token\.name, currentName\)\);\s*if \(!ok\) return;\s*revoke\.mutate\(token\.id\)/],
      ['webhooks/page.tsx', /if \(await confirm\(confirmToggleWebhook\(hook\.url, !hook\.enabled\)\)\) toggle\.mutate/],
      ['integrations/google-calendar/page.tsx', /if \(await confirm\(confirmRemoveCalendarMapping\([^)]*\)\)\) remove\.mutate\(binding\.id\)/],
    ];
    for (const [file, re] of cases) expect(page(file), `${file} ${re}`).toMatch(re);
  });

  it('no action still calls its mutation straight from the click', () => {
    expect(page('members/page.tsx')).not.toMatch(/onClick=\{\(\) => removeMember\.mutate/);
    expect(page('members/page.tsx')).not.toMatch(/onRevoke=\{\(\) => revokeInvite\.mutate/);
    expect(page('members/page.tsx')).not.toMatch(/onChange=\{\(e\) => updateMember\.mutate/);
    expect(page('webhooks/page.tsx')).not.toMatch(/onClick=\{\(\) => toggle\.mutate/);
    expect(page('integrations/google-calendar/page.tsx')).not.toMatch(/onClick=\{\(\) => remove\.mutate/);
    expect(page('account/page.tsx')).not.toMatch(/onClick=\{\(\) => revoke\.mutate/);
  });
});
