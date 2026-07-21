import { afterEach, describe, expect, it } from 'vitest';
import { databaseUrl, recordUrl, viewUrl, webBaseUrl } from './links.js';

const ORIGINAL_WEB_URL = process.env.WEB_URL;

afterEach(() => {
  if (ORIGINAL_WEB_URL === undefined) delete process.env.WEB_URL;
  else process.env.WEB_URL = ORIGINAL_WEB_URL;
});

describe('webBaseUrl (#268)', () => {
  it('defaults to the local dev web server', () => {
    delete process.env.WEB_URL;
    expect(webBaseUrl()).toBe('http://localhost:3000');
  });

  it('reads WEB_URL and strips a trailing slash', () => {
    process.env.WEB_URL = 'https://app.storyos.dev/';
    expect(webBaseUrl()).toBe('https://app.storyos.dev');
  });
});

describe('recordUrl (#268)', () => {
  afterEach(() => {
    delete process.env.WEB_URL;
  });

  it('builds a title-slug + number link when the record has a public number', () => {
    process.env.WEB_URL = 'https://app.storyos.dev';
    const url = recordUrl('ws-1', 'db-1', { id: 'rec-uuid-1', title: 'Fix the Bug!!', number: 42 });
    expect(url).toBe('https://app.storyos.dev/w/ws-1/d/db-1/r/fix-the-bug-42');
  });

  it('is addressable and stable regardless of how the record was looked up (number vs uuid) — same row, same url', () => {
    process.env.WEB_URL = 'https://app.storyos.dev';
    const row = { id: 'rec-uuid-1', title: 'Fix the Bug', number: 42 };
    // Whether the caller passed record="42" or record="rec-uuid-1" to get_record,
    // the resolved row is identical, so the constructed link must be too.
    expect(recordUrl('ws-1', 'db-1', row)).toBe(recordUrl('ws-1', 'db-1', row));
  });

  it('falls back to the record uuid when there is no public number yet', () => {
    process.env.WEB_URL = 'https://app.storyos.dev';
    const url = recordUrl('ws-1', 'db-1', { id: 'rec-uuid-2', title: 'Untitled draft', number: null });
    expect(url).toBe('https://app.storyos.dev/w/ws-1/d/db-1/r/rec-uuid-2');
  });

  it('falls back to the uuid when the title is empty', () => {
    const url = recordUrl('ws-1', 'db-1', { id: 'rec-uuid-3', title: '', number: 7 });
    expect(url).toBe(`${webBaseUrl()}/w/ws-1/d/db-1/r/7`);
  });

  it('strips non-alphanumeric characters and collapses them to single hyphens', () => {
    const url = recordUrl('ws-1', 'db-1', { id: 'rec-uuid-4', title: '  Weird!!  Title__ 123 ', number: 5 });
    expect(url).toBe(`${webBaseUrl()}/w/ws-1/d/db-1/r/weird-title-123-5`);
  });
});

describe('databaseUrl / viewUrl (#268)', () => {
  it('links a database', () => {
    expect(databaseUrl('ws-1', 'db-1')).toBe(`${webBaseUrl()}/w/ws-1/d/db-1`);
  });

  it('links a saved view via the ?view= query param', () => {
    expect(viewUrl('ws-1', 'db-1', 'view-1')).toBe(`${webBaseUrl()}/w/ws-1/d/db-1?view=view-1`);
  });
});
