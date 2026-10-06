import { describe, expect, it } from 'vitest';
import { coverImageUrl, isCoverField, isUrlCoverField } from './cover-fields';

describe('isCoverField (#825)', () => {
  it('accepts attachment, url and text — and nothing else', () => {
    for (const t of ['attachment', 'url', 'text']) expect(isCoverField({ type: t }), t).toBe(true);
    for (const t of ['title', 'number', 'select', 'date', 'relation', 'email', 'rich_text', 'formula']) {
      expect(isCoverField({ type: t }), t).toBe(false);
    }
  });
  it('only url/text are URL covers; an attachment keeps its own path', () => {
    expect(isUrlCoverField({ type: 'url' })).toBe(true);
    expect(isUrlCoverField({ type: 'attachment' })).toBe(false);
  });
});

describe('coverImageUrl', () => {
  it('passes http(s) URLs, trimmed', () => {
    expect(coverImageUrl(' https://example.com/a.png ')).toBe('https://example.com/a.png');
    expect(coverImageUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });
  // The cases the filter must REFUSE: a text column holds anything.
  it('refuses non-URLs and non-http schemes', () => {
    for (const bad of ['', '   ', 'not a url', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://x/y.png', null, undefined, 42, {}]) {
      expect(coverImageUrl(bad), String(bad)).toBeNull();
    }
  });
});
