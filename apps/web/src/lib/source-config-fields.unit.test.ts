import { describe, expect, it } from 'vitest';
import {
  configFieldLabel,
  humanizeKey,
  parseListValue,
  validateConfigField,
} from './source-config-fields';

describe('humanizeKey', () => {
  it('turns snake_case into Title Case', () => {
    expect(humanizeKey('published_at')).toBe('Published At');
    expect(humanizeKey('author_name')).toBe('Author Name');
  });

  it('upper-cases known acronyms', () => {
    expect(humanizeKey('video_id')).toBe('Video ID');
    expect(humanizeKey('post_urns')).toBe('Post URNS');
  });

  it('splits camelCase', () => {
    expect(humanizeKey('igUserId')).toBe('IG User ID');
  });
});

describe('configFieldLabel', () => {
  it('prefers an explicit override for cryptic keys', () => {
    expect(configFieldLabel('page_id')).toBe('Facebook Page ID');
    expect(configFieldLabel('ig_user_id')).toBe('Instagram Business Account ID');
    expect(configFieldLabel('post_urns')).toBe('LinkedIn post URNs');
  });

  it('falls back to humanize for unlisted keys', () => {
    expect(configFieldLabel('some_new_field')).toBe('Some New Field');
  });
});

describe('parseListValue', () => {
  it('splits on newlines', () => {
    expect(parseListValue('urn:li:share:1\nurn:li:share:2')).toEqual(['urn:li:share:1', 'urn:li:share:2']);
  });

  it('splits on commas too, trimming and dropping blanks', () => {
    expect(parseListValue(' a , b ,\n, c \n')).toEqual(['a', 'b', 'c']);
  });
});

describe('validateConfigField', () => {
  it('accepts valid LinkedIn URNs', () => {
    expect(validateConfigField('linkedin.org_engagement', 'post_urns', 'urn:li:share:123\nurn:li:ugcPost:456')).toBeNull();
  });

  it('flags entries that are not urn:li: URNs', () => {
    const err = validateConfigField('linkedin.org_engagement', 'post_urns', 'urn:li:share:1\nnope\n12345');
    expect(err).toMatch(/Not a LinkedIn URN/);
    expect(err).toContain('nope');
  });

  it('ignores fields it has no rule for', () => {
    expect(validateConfigField('meta.page_comments', 'page_id', 'anything')).toBeNull();
    expect(validateConfigField('x.mentions', 'user_id', '')).toBeNull();
  });
});
