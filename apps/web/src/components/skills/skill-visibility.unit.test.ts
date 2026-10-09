import { skillVisibilitySchema } from '@storyos/schemas';
import { describe, expect, it } from 'vitest';
import { draftBody, draftFromSkill, draftProblem, draftFromTemplate } from './skill-editor';
import { VISIBILITY_CHIP, VISIBILITY_OPTIONS, audienceProblem, narrowingMessage, narrowsAudience, publicSkillUrl } from './skill-meta';

const tiers = skillVisibilitySchema.options;

describe('the picker offers every tier the API accepts (ticket #833 / #841)', () => {
  it('offers exactly the schema enum — no fewer (the bug) and no more', () => {
    expect(VISIBILITY_OPTIONS.map((o) => o.value).sort()).toEqual([...tiers].sort());
  });
  it('has a chip label for every tier', () => {
    expect(Object.keys(VISIBILITY_CHIP).sort()).toEqual([...tiers].sort());
  });
  it('says "Only me" and never "private", on the chip or the picker', () => {
    expect(VISIBILITY_CHIP.personal).toBe('Only me');
    expect(VISIBILITY_OPTIONS.find((o) => o.value === 'personal')!.label).toBe('Only me — you and workspace admins');
    const all = [...Object.values(VISIBILITY_CHIP), ...VISIBILITY_OPTIONS.flatMap((o) => [o.label, o.hint])];
    for (const text of all) expect(text).not.toMatch(/private/i);
  });
  it('states what each choice costs', () => {
    for (const o of VISIBILITY_OPTIONS) expect(o.hint.length).toBeGreaterThan(10);
    expect(VISIBILITY_OPTIONS.find((o) => o.value === 'public')!.hint).toMatch(/not|anyone/i);
  });
});

describe('audienceProblem', () => {
  it('flags `members` with nobody but the owner named', () => {
    expect(audienceProblem('members', [], 'u1')).toMatch(/at least one person/);
    expect(audienceProblem('members', ['u1'], 'u1')).toMatch(/at least one person/);
  });
  it('keeps `members` with someone else named, and every other tier', () => {
    expect(audienceProblem('members', ['u1', 'u2'], 'u1')).toBeNull();
    for (const t of ['personal', 'shared', 'public'] as const) expect(audienceProblem(t, [], 'u1')).toBeNull();
  });
});

describe('narrowsAudience', () => {
  it('is true only when the audience gets smaller', () => {
    expect(narrowsAudience('shared', 'personal')).toBe(true);
    expect(narrowsAudience('public', 'members')).toBe(true);
    expect(narrowsAudience('personal', 'shared')).toBe(false);
    expect(narrowsAudience('shared', 'shared')).toBe(false);
  });
});

describe('publicSkillUrl', () => {
  it('builds the link from the token and tolerates a trailing slash', () => {
    expect(publicSkillUrl('http://x/', 'a b')).toBe('http://x/api/v1/public/skills/a%20b');
  });
  it('is null without a token', () => {
    expect(publicSkillUrl('http://x', null)).toBeNull();
    expect(publicSkillUrl('http://x', undefined)).toBeNull();
  });
});

describe('the editor draft', () => {
  const base = { ...draftFromTemplate(undefined), name: 'n', description: 'd', when_to_use: 'w', instructions: 'i' };
  it('omits an empty version and member_ids unless the tier is members', () => {
    expect(draftBody(base)).not.toHaveProperty('version');
    expect(draftBody(base)).not.toHaveProperty('member_ids');
    expect(draftBody({ ...base, version: '1.2.0' })).toMatchObject({ version: '1.2.0' });
    expect(draftBody({ ...base, visibility: 'members', member_ids: ['u2'] })).toMatchObject({ member_ids: ['u2'] });
  });
  it('rejects a version that is not semver, accepts one that is', () => {
    expect(draftProblem({ ...base, version: 'v2' }, 'u1')).toMatch(/1\.2\.0/);
    expect(draftProblem({ ...base, version: '2.0.1-rc.1' }, 'u1')).toBeNull();
  });
  it('blocks saving `members` with nobody named', () => {
    expect(draftProblem({ ...base, visibility: 'members' }, 'u1')).toMatch(/at least one person/);
  });
  it('round-trips a stored skill', () => {
    const d = draftFromSkill({ name: 'n', description: 'd', when_to_use: 'w', instructions: 'i', visibility: 'members', version: '1.0.0', member_ids: ['u1', 'u2'] } as never);
    expect(d).toMatchObject({ version: '1.0.0', member_ids: ['u1', 'u2'], visibility: 'members' });
  });
});

describe('narrowingMessage (ticket #833 polish)', () => {
  it('names the from and to tiers and what people lose', () => {
    const m = narrowingMessage('shared', 'personal');
    expect(m).toContain('“Workspace”');
    expect(m).toContain('“Only me”');
    expect(m).toMatch(/can no longer find or run it/);
  });
  it('says the public link stops working when leaving public, and only then', () => {
    expect(narrowingMessage('public', 'shared')).toMatch(/public link stops working/);
    expect(narrowingMessage('public', 'personal')).toMatch(/public link stops working/);
    expect(narrowingMessage('shared', 'members')).not.toMatch(/link/);
  });
});
