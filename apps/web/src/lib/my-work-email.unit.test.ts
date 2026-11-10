import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EMAILED_EVENTS,
  MY_WORK_OFFER_HINT,
  emailLine,
  myWorkEmailPatch,
  senderShortName,
  showMyWorkOffer,
  timeOptions,
  zoneLabel,
} from './my-work-email';
import type { MyWorkEmailPrefs } from './my-work-email';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const OFF: MyWorkEmailPrefs = { frequency: 'off', weekday: 1, time: '09:00', timezone: null, include_assigned_by_me: false };

describe('the one-time Inbox offer (ticket #1252)', () => {
  const base = { email: OFF, dismissed: [] as string[], openAssigned: 5 };

  it('shows at exactly 5 open assigned records, Off, never answered', () => {
    expect(showMyWorkOffer(base)).toBe(true);
    expect(showMyWorkOffer({ ...base, openAssigned: 148 })).toBe(true);
  });

  it('does not show below 5 (the boundary), including 0', () => {
    expect(showMyWorkOffer({ ...base, openAssigned: 4 })).toBe(false);
    expect(showMyWorkOffer({ ...base, openAssigned: 0 })).toBe(false);
  });

  it('never shows again after any answer: dismissed (x / Not now) or accepted (the setting is no longer Off)', () => {
    expect(showMyWorkOffer({ ...base, dismissed: [MY_WORK_OFFER_HINT] })).toBe(false);
    expect(showMyWorkOffer({ ...base, email: { ...OFF, frequency: 'daily' } })).toBe(false);
    expect(showMyWorkOffer({ ...base, email: { ...OFF, frequency: 'weekly' } })).toBe(false);
  });

  it('KEEPS showing when the person only dismissed OTHER hints', () => {
    expect(showMyWorkOffer({ ...base, dismissed: ['agent-runs-explainer', 'something-else'] })).toBe(true);
  });

  it('never guesses: an unknown anything hides it (loading hints, no total, no preference group)', () => {
    expect(showMyWorkOffer({ ...base, dismissed: undefined })).toBe(false);
    expect(showMyWorkOffer({ ...base, openAssigned: undefined })).toBe(false);
    expect(showMyWorkOffer({ ...base, email: undefined })).toBe(false);
  });
});

describe('the sentence about email on Notifications (ticket #1264)', () => {
  const sender = { name: 'Quill from StoryOS', address: 'quill@storyos.dev' };

  it('populated: names the person’s address and the sender (name shortened, address kept)', () => {
    expect(emailLine({ email: 'ana@acme.com', mail_sender: sender })).toEqual({
      kind: 'sent',
      email: 'ana@acme.com',
      senderName: 'Quill',
      senderAddress: 'quill@storyos.dev',
    });
  });

  it('null sender (the server says none is configured): the self-hosted message, not the "sent" line', () => {
    expect(emailLine({ email: 'ana@acme.com', mail_sender: null })).toEqual({ kind: 'not_set_up' });
  });

  it('an API WITHOUT the field (undefined) is not "not set up": nothing is claimed either way', () => {
    expect(emailLine({ email: 'ana@acme.com' })).toEqual({ kind: 'unknown' });
    expect(emailLine(undefined)).toEqual({ kind: 'unknown' });
  });

  it('claims nothing it cannot fill: no address on the person or on the sender is unknown, not a half sentence', () => {
    expect(emailLine({ mail_sender: sender })).toEqual({ kind: 'unknown' });
    expect(emailLine({ email: 'ana@acme.com', mail_sender: { name: 'Quill', address: ' ' } })).toEqual({ kind: 'unknown' });
  });

  it('keeps a sender name that is not "X from Y" as it is', () => {
    expect(senderShortName('Acme Mail')).toBe('Acme Mail');
    expect(senderShortName('Quill from StoryOS')).toBe('Quill');
    expect(senderShortName('')).toBeNull();
    expect(senderShortName(null)).toBeNull();
  });

  it('only the two events that email today are tagged; the other three are Inbox only', () => {
    expect([...EMAILED_EVENTS].sort()).toEqual(['mentioned', 'record_changed']);
  });

  it('the static operator line is gone from the page, and the page uses the shared line + box', () => {
    const page = read('app/w/[ws]/settings/notifications/page.tsx');
    expect(page).not.toContain('Email notifications arrive when email delivery is enabled');
    expect(page).toContain('emailLine(me.data)');
    expect(page).toContain('<MyWorkEmailBox />');
    expect(page).toContain("t set up on this StoryOS server. Ask your admin.");
  });
});

describe('saving the setting', () => {
  it('names only what changed, plus the browser zone when it is known', () => {
    expect(myWorkEmailPatch({ frequency: 'weekly' }, 'Europe/Madrid')).toEqual({ myWorkEmail: { frequency: 'weekly', timezone: 'Europe/Madrid' } });
  });

  it('with no browser zone sends none, so the stored zone is kept (not overwritten with null = UTC)', () => {
    const body = myWorkEmailPatch({ time: '08:30' }, null);
    expect(body).toEqual({ myWorkEmail: { time: '08:30' } });
    expect('timezone' in body.myWorkEmail).toBe(false);
  });

  it('a saved time that is not on the half hour stays selectable and in order', () => {
    const t = timeOptions('09:15').map((o) => o.value);
    expect(t).toContain('09:15');
    expect(t.indexOf('09:15')).toBeGreaterThan(t.indexOf('09:00'));
    expect(t.indexOf('09:15')).toBeLessThan(t.indexOf('09:30'));
    expect(timeOptions('09:00')).toHaveLength(48);
  });

  it('names the zone and its offset; no zone is UTC', () => {
    expect(zoneLabel('Europe/Madrid', new Date('2026-11-10T12:00:00Z'))).toBe('Europe/Madrid (UTC+1)');
    expect(zoneLabel('America/New_York', new Date('2026-07-10T12:00:00Z'))).toBe('America/New York (UTC−4)');
    expect(zoneLabel(null)).toBe('UTC');
  });

  it('Weekly shows the day (and the box is hidden when the API did not return the group)', () => {
    const box = read('components/settings/my-work-email-box.tsx');
    expect(box).toMatch(/saved\.frequency === 'weekly'[\s\S]*label="Day"/);
    expect(box).toContain('if (!saved) return null;');
  });

  it('the Inbox mounts the offer, which stores its answer as a server-side hint and counts with the exact total', () => {
    expect(read('app/w/[ws]/inbox/page.tsx')).toContain('<MyWorkEmailOffer ws={ws} />');
    const offer = read('components/my-work/my-work-email-offer.tsx');
    expect(offer).toContain('hints.setDismissed(MY_WORK_OFFER_HINT, true)');
    expect(offer).toContain("typeof total === 'number'");
  });
});
