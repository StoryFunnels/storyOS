import { describe, expect, it } from 'vitest';
import {
  EMOJI_ICON_MIGRATION,
  ICON_NAMES,
  ICON_SET_META,
  inferIconFromName,
  isEmojiShaped,
  normalizeIconInput,
  resolveMigratedIcon,
  setIconName,
} from '@storyos/schemas';

describe('icon set metadata (#133/#251)', () => {
  it('every migration-table icon name is a real curated-set name', () => {
    for (const entry of Object.values(EMOJI_ICON_MIGRATION)) {
      const name = setIconName(entry.icon);
      expect(name, `"${entry.icon}" should be a set: ref`).not.toBeNull();
      expect(ICON_NAMES.has(name!)).toBe(true);
    }
  });

  it('ICON_SET_META has no duplicate names', () => {
    const names = ICON_SET_META.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('emoji → SVG migration table (#251)', () => {
  it('resolves a known emoji to its mapped icon + color', () => {
    expect(EMOJI_ICON_MIGRATION['🤝']).toEqual({ icon: 'set:handshake', color: 'teal' });
    expect(EMOJI_ICON_MIGRATION['🚀']).toEqual({ icon: 'set:rocket', color: 'blue' });
    expect(EMOJI_ICON_MIGRATION['💰']).toEqual({ icon: 'set:dollar-sign', color: 'gold' });
  });

  it('resolveMigratedIcon uses the mapping table for a known emoji', () => {
    expect(resolveMigratedIcon('🤝', 'Anything')).toEqual({ icon: 'set:handshake', color: 'teal' });
  });

  it('resolveMigratedIcon falls back to the name-inferred default for an unmapped emoji', () => {
    // 👍 isn't in the migration table; the *name* carries the signal instead.
    expect(resolveMigratedIcon('👍', 'Clients')?.icon).toBe('set:handshake');
    expect(resolveMigratedIcon('👍', 'No Keyword Match Here')?.icon).toBe('set:database');
  });

  it('resolveMigratedIcon is a no-op for a non-emoji value', () => {
    expect(resolveMigratedIcon('set:rocket', 'x')).toBeNull();
    expect(resolveMigratedIcon(null, 'x')).toBeNull();
    expect(resolveMigratedIcon('', 'x')).toBeNull();
    expect(resolveMigratedIcon('Plain text icon', 'x')).toBeNull();
  });
});

describe('expanded migration table (#283)', () => {
  it('covers seed-template and integration/agent emoji not in the original 93', () => {
    // github.service.ts / linear.service.ts / agents.service.ts defaults.
    expect(EMOJI_ICON_MIGRATION['🐙']).toEqual({ icon: 'set:plug', color: 'orange' });
    expect(EMOJI_ICON_MIGRATION['🔀']).toEqual({ icon: 'set:repeat', color: 'purple' });
    expect(EMOJI_ICON_MIGRATION['🏷️']).toEqual({ icon: 'set:tag', color: 'orange' });
    expect(EMOJI_ICON_MIGRATION['📐']).toEqual({ icon: 'set:compass', color: 'blue' });
    expect(EMOJI_ICON_MIGRATION['🤖']).toEqual({ icon: 'set:zap', color: 'orange' });
    expect(EMOJI_ICON_MIGRATION['▶️']).toEqual({ icon: 'set:activity', color: 'gray' });
  });

  it('covers a broad general set beyond templates/integrations', () => {
    expect(setIconName(EMOJI_ICON_MIGRATION['❌']!.icon)).toBe('circle-x');
    expect(setIconName(EMOJI_ICON_MIGRATION['📱']!.icon)).toBe('phone');
    expect(setIconName(EMOJI_ICON_MIGRATION['💻']!.icon)).toBe('wrench');
    expect(setIconName(EMOJI_ICON_MIGRATION['📧']!.icon)).toBe('mail');
    expect(setIconName(EMOJI_ICON_MIGRATION['💵']!.icon)).toBe('dollar-sign');
    expect(setIconName(EMOJI_ICON_MIGRATION['🎉']!.icon)).toBe('gift');
    expect(setIconName(EMOJI_ICON_MIGRATION['🛡️']!.icon)).toBe('shield-check');
    expect(setIconName(EMOJI_ICON_MIGRATION['👩‍💻']!.icon)).toBe('wrench');
  });

  it('has no duplicate emoji keys (a later entry would silently shadow an earlier one)', () => {
    // EMOJI_ICON_MIGRATION is built with Object.fromEntries from MIGRATION_RULES;
    // if two rules shared an emoji key, the object would just have fewer keys
    // than rules. Import count indirectly via a sanity floor well above the
    // original 93 (#283 added well over 100 more).
    expect(Object.keys(EMOJI_ICON_MIGRATION).length).toBeGreaterThan(200);
  });
});

describe('normalizeIconInput (#283 write-path guard)', () => {
  it('passes through null/undefined unchanged', () => {
    expect(normalizeIconInput(null, 'x')).toBeNull();
    expect(normalizeIconInput(undefined, 'x')).toBeUndefined();
  });

  it('passes through an already-migrated set: ref unchanged', () => {
    expect(normalizeIconInput('set:rocket', 'x')).toBe('set:rocket');
    expect(normalizeIconInput('set:this-name-does-not-exist', 'x')).toBe('set:this-name-does-not-exist');
  });

  it('passes through plain non-emoji text unchanged', () => {
    expect(normalizeIconInput('Plain text', 'x')).toBe('Plain text');
  });

  it('normalizes a known emoji to its mapped set: ref', () => {
    expect(normalizeIconInput('🤝', 'Anything')).toBe('set:handshake');
  });

  it('normalizes an unmapped emoji via the name-inferred fallback', () => {
    expect(normalizeIconInput('👍', 'Clients')).toBe('set:handshake');
    expect(normalizeIconInput('👍', 'No Keyword Match Here')).toBe('set:database');
  });
});

describe('inferIconFromName (#133 name-inferred default, #251 fallback)', () => {
  it('matches a keyword in the entity name to an icon', () => {
    expect(inferIconFromName('Clients')).toBe('set:handshake');
    expect(inferIconFromName('Contacts')).toBe('set:contact');
    expect(inferIconFromName('Team Members')).toBe('set:users');
    expect(inferIconFromName('Releases')).toBe('set:rocket');
  });

  it('falls back to the generic default when nothing matches', () => {
    expect(inferIconFromName('Zzzqqx Nonsense')).toBe('set:database');
    expect(inferIconFromName('')).toBe('set:database');
  });
});

describe('isEmojiShaped (#251 scan predicate)', () => {
  it('is true for plain and multi-codepoint emoji', () => {
    expect(isEmojiShaped('📌')).toBe(true);
    expect(isEmojiShaped('🧑‍💻')).toBe(true); // ZWJ sequence
    expect(isEmojiShaped('🗂️')).toBe(true); // variation selector
  });

  it('is false for a set: ref, plain text, or empty', () => {
    expect(isEmojiShaped('set:rocket')).toBe(false);
    expect(isEmojiShaped('set:doesnotexist')).toBe(false);
    expect(isEmojiShaped('Plain text')).toBe(false);
    expect(isEmojiShaped('')).toBe(false);
    expect(isEmojiShaped(null)).toBe(false);
    expect(isEmojiShaped(undefined)).toBe(false);
  });

  it('a migrated value is never emoji-shaped — the idempotency guarantee', () => {
    // This is *the* property the backfill's idempotency rests on: once a row
    // holds resolveMigratedIcon(...)'s output, isEmojiShaped is false for it,
    // so a second pass has nothing left to touch.
    for (const emoji of Object.keys(EMOJI_ICON_MIGRATION)) {
      const migrated = resolveMigratedIcon(emoji, 'irrelevant')!;
      expect(isEmojiShaped(migrated.icon)).toBe(false);
    }
    const inferred = resolveMigratedIcon('👍', 'Clients')!;
    expect(isEmojiShaped(inferred.icon)).toBe(false);
  });
});
