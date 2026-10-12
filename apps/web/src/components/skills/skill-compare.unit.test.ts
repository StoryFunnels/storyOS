import { describe, expect, it } from 'vitest';
import { SKILL_TEMPLATES } from '@storyos/schemas';
import {
  CLOSE_THRESHOLD,
  compareToRivals,
  discoveryBlock,
  estimateTokens,
  markSegments,
  similarity,
  skillSlug,
  stem,
} from './skill-compare';

const tpl = (id: string) => SKILL_TEMPLATES.find((t) => t.id === id)!;

describe('the two shipped scaffolds that genuinely collide (the specimen the design rests on)', () => {
  const lead = tpl('lead-triage-reply').when_to_use;
  const support = tpl('support-reply-drafter').when_to_use;
  const digest = tpl('weekly-digest').when_to_use;

  it('reads the real strings, not an invented pair', () => {
    expect(lead).toMatch(/Leads-shaped/);
    expect(support).toMatch(/support\/ticket-shaped/);
  });
  it('scores the colliding pair above the "too close" line and the unrelated pair below it', () => {
    expect(similarity(lead, support)).toBeGreaterThanOrEqual(CLOSE_THRESHOLD);
    expect(similarity(support, digest)).toBeLessThan(CLOSE_THRESHOLD);
    expect(similarity(lead, digest)).toBeLessThan(CLOSE_THRESHOLD);
  });
  it('names the colliding rival, with the words they share, as too close to call', () => {
    const c = compareToRivals(support, [
      { id: 'a', name: 'Lead triage reply drafter', when_to_use: lead },
      { id: 'b', name: 'Weekly status digest', when_to_use: digest },
    ]);
    expect(c.verdict.kind).toBe('close');
    if (c.verdict.kind === 'close') {
      expect(c.verdict.nearest).toBe('Lead triage reply drafter');
      expect(c.verdict.sharedWords).toEqual(expect.arrayContaining(['reply']));
    }
    expect(c.rivals[0]!.name).toBe('Lead triage reply drafter');
  });
  it('calls an unrelated draft distinct', () => {
    const c = compareToRivals(digest, [{ id: 'a', name: 'Support reply drafter', when_to_use: support }]);
    expect(c.verdict.kind).toBe('distinct');
  });
});

describe('compareToRivals states', () => {
  it('is empty for a blank draft, and "alone" when there is nothing to compare against', () => {
    expect(compareToRivals('   ', []).verdict.kind).toBe('empty');
    expect(compareToRivals('When an invoice is overdue', []).verdict.kind).toBe('alone');
  });
  it('ignores rivals that have no when_to_use, rather than scoring them as zero overlap', () => {
    const c = compareToRivals('When an invoice is overdue', [{ id: 'x', name: 'Blank', when_to_use: '  ' }]);
    expect(c.verdict.kind).toBe('alone');
    expect(c.rivals).toEqual([]);
  });
  it('shows at most `limit` rivals, closest first', () => {
    const rivals = ['reply to a support ticket', 'summarise weekly state changes', 'reply to a lead', 'archive old records'].map(
      (w, i) => ({ id: String(i), name: `S${i}`, when_to_use: w }),
    );
    const c = compareToRivals('draft a reply to a support ticket', rivals, 2);
    expect(c.rivals).toHaveLength(2);
    expect(c.rivals[0]!.similarity).toBeGreaterThanOrEqual(c.rivals[1]!.similarity);
  });
});

describe('markSegments', () => {
  it('always reassembles to the original text exactly — marking never rewrites it', () => {
    const text = 'When a support/ticket-shaped record comes in, and a human wants a reply!';
    for (const markUnique of [true, false]) {
      expect(markSegments(text, 'reply to a lead record', markUnique).map((s) => s.text).join('')).toBe(text);
    }
  });
  it('marks shared content words, and what only this text says when asked', () => {
    const segs = markSegments('draft a reply for the invoice', 'reply to a lead', true);
    expect(segs.find((s) => s.kind === 'shared')?.text).toContain('reply');
    expect(segs.find((s) => s.kind === 'unique')?.text).toMatch(/draft|invoice/);
    const plainOnly = markSegments('draft a reply for the invoice', 'reply to a lead', false);
    expect(plainOnly.some((s) => s.kind === 'unique')).toBe(false);
  });
  it('never marks stopwords as shared overlap', () => {
    const segs = markSegments('when the', 'when the', true);
    expect(segs.every((s) => s.kind === 'plain')).toBe(true);
  });
});

describe('stem', () => {
  it('meets plurals and tenses', () => {
    expect(stem('replies')).toBe(stem('reply'));
    expect(stem('drafted')).toBe(stem('draft'));
    expect(stem('drafts')).toBe(stem('draft'));
  });
});

describe('discoveryBlock + estimateTokens', () => {
  const s = { name: 'Support reply drafter', description: 'Drafts a reply.', when_to_use: 'When a ticket comes in.' };
  it('is exactly the three discovery fields, with a slugged name — and no allowed_tools', () => {
    expect(discoveryBlock(s)).toBe(
      'name: support-reply-drafter\ndescription: Drafts a reply.\nwhen-to-use: When a ticket comes in.',
    );
    expect(discoveryBlock(s)).not.toMatch(/allowed/i);
  });
  it('estimates ~4 characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
  it('slugs a name without leaving hyphen debris', () => {
    expect(skillSlug('  Lead  triage / reply! ')).toBe('lead-triage-reply');
    expect(skillSlug('!!!')).toBe('skill');
  });
});

describe('padding cannot buy a false all-clear', () => {
  const lead = tpl('lead-triage-reply').when_to_use;
  const support = tpl('support-reply-drafter').when_to_use;
  it('still calls a colliding sentence close after unrelated words are appended to it', () => {
    const padded = `${support} When a customer writes in about a problem with their order, billing or login and the Ticket status is Open.`;
    expect(compareToRivals(padded, [{ id: 'a', name: 'Lead triage reply drafter', when_to_use: lead }]).verdict.kind).toBe('close');
  });
  it('does not turn two unrelated skills close just because one is long', () => {
    const long = `${tpl('weekly-digest').when_to_use} ${'Also covers quarterly planning, hiring pipelines, vendor renewals, and budget reviews across every department. '.repeat(3)}`;
    expect(compareToRivals(long, [{ id: 'a', name: 'Lead triage reply drafter', when_to_use: lead }]).verdict.kind).toBe('distinct');
  });
  it('does not count a tiny text as "contained" in a big one on one or two shared words', () => {
    expect(similarity('reply', lead)).toBeLessThan(CLOSE_THRESHOLD);
  });
});
