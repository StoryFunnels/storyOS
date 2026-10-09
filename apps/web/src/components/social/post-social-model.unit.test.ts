import { describe, expect, it } from 'vitest';
import type { Field } from '@/components/table-view/use-table-data';
import {
  TARGET_LIMIT,
  imageThatWillBePublished,
  lengthFor,
  mediaFields,
  postSnapshotOf,
  providerForTarget,
  resultFields,
  targetsFor,
} from './post-social-model';

const f = (type: string, extra: Record<string, unknown> = {}) => ({ id: type, type, ...extra }) as unknown as Field;

describe('targets and providers (ticket #826)', () => {
  it('offers each connection only the targets its provider can post as', () => {
    expect(targetsFor('x')).toEqual(['x']);
    expect(targetsFor('linkedin')).toEqual(['linkedin_org', 'linkedin_member']);
    expect(targetsFor('resend')).toEqual([]);
  });
  it('maps every target back to its provider, as the server checks it', () => {
    expect(providerForTarget('x')).toBe('x');
    expect(providerForTarget('linkedin_org')).toBe('linkedin');
    expect(providerForTarget('linkedin_member')).toBe('linkedin');
  });
});

describe('lengthFor', () => {
  it('measures X weighted: a link counts 23 however long it is', () => {
    const url = 'https://example.com/a/very/long/path/that/goes/on/and/on/forever/and/ever';
    expect(lengthFor('x', url).length).toBe(23);
    expect(lengthFor('linkedin_org', url).length).toBe(url.length);
  });
  it('uses each target’s own limit and flags only what is over it', () => {
    expect(lengthFor('x', 'a'.repeat(280))).toEqual({ length: 280, limit: 280, over: false });
    expect(lengthFor('x', 'a'.repeat(281)).over).toBe(true);
    expect(lengthFor('linkedin_member', 'a'.repeat(281)).over).toBe(false);
    expect(lengthFor('linkedin_org', 'a'.repeat(3001)).over).toBe(true);
    expect(TARGET_LIMIT.x).toBe(280);
  });
  it('counts CJK as double on X, the way X does', () => {
    expect(lengthFor('x', '日'.repeat(140)).over).toBe(false);
    expect(lengthFor('x', '日'.repeat(141)).over).toBe(true);
  });
});

describe('field pickers', () => {
  it('media: attachment fields only', () => {
    expect(mediaFields([f('text'), f('attachment'), f('url')]).map((x) => x.type)).toEqual(['attachment']);
  });
  it('result: url and text fields, never a system one', () => {
    const out = resultFields([f('url'), f('text'), f('text', { isSystem: true }), f('number'), f('attachment')]);
    expect(out.map((x) => x.type)).toEqual(['url', 'text']);
  });
});

describe('imageThatWillBePublished', () => {
  const att = (id: string) => ({ id, filename: `${id}.png`, mime: 'image/png', has_thumbnail: true });
  it('is the FIRST attachment, and says how many others will not go out', () => {
    expect(imageThatWillBePublished([att('a'), att('b'), att('c')])).toEqual({ attachment: att('a'), extra: 2 });
  });
  it('is null when the field is empty or not an attachment list', () => {
    expect(imageThatWillBePublished([])).toBeNull();
    expect(imageThatWillBePublished(null)).toBeNull();
    expect(imageThatWillBePublished('x')).toBeNull();
  });
});

describe('postSnapshotOf', () => {
  // The shape a real approval row carries (copied from a live one): the action sits under `.action`.
  const real = {
    action_snapshot: {
      ctx: { workspaceId: 'w', databaseId: 'd', recordId: 'r', actorId: 'a' },
      action: { type: 'post_social', target: 'x', text: 'Launch day', connection_id: 'c', media_field_id: 'm' },
    },
  };
  it('reads the post out of a real approval snapshot', () => {
    expect(postSnapshotOf(real)?.text).toBe('Launch day');
    expect(postSnapshotOf(real)?.media_field_id).toBe('m');
  });
  it('is null for any other action, and for a missing approval or snapshot', () => {
    expect(postSnapshotOf({ action_snapshot: { action: { type: 'send_email' } } })).toBeNull();
    expect(postSnapshotOf({ action_snapshot: null })).toBeNull();
    expect(postSnapshotOf(undefined)).toBeNull();
  });
  it('does NOT find a post when the action is at the top level (the first draft’s wrong shape)', () => {
    expect(postSnapshotOf({ action_snapshot: { type: 'post_social' } } as never)).toBeNull();
  });
});
