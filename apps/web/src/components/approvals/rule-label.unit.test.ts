import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApprovalRuleTail } from './use-approval-view';
import { approvalRuleTail, ruleIsGiven, ruleIsWithheld, type ApprovalRuleFields } from './rule-label';

/**
 * Ticket #1280 — the approval row names the automation rule asking, exactly as the API (PR 1533) lets THIS viewer know it.
 * Three inputs, one helper, two surfaces.
 */
const GIVEN: ApprovalRuleFields = { rule_id: 'r1', rule_name: 'Notify Finance', rule_label: 'Notify Finance' };
const WITHHELD_DB: ApprovalRuleFields = { rule_id: null, rule_name: null, rule_label: 'A rule in Tasks' };
const WITHHELD_BARE: ApprovalRuleFields = { rule_id: null, rule_name: null, rule_label: 'A rule' };
const NONE: ApprovalRuleFields = { rule_id: null, rule_name: null, rule_label: null };

describe('approvalRuleTail', () => {
  it('GIVEN: the rule name', () => {
    expect(approvalRuleTail(GIVEN)).toBe('Notify Finance');
    expect(ruleIsGiven(GIVEN)).toBe(true);
    expect(ruleIsWithheld(GIVEN)).toBe(false);
  });
  it('GATED: the neutral "a rule in <database>", never a name or an id', () => {
    const tail = approvalRuleTail(WITHHELD_DB);
    expect(tail).toBe('a rule in Tasks');
    expect(ruleIsWithheld(WITHHELD_DB)).toBe(true);
  });
  it('a withheld label is NEVER filled from rule_name or rule_id, even if a stale payload carried them', () => {
    expect(approvalRuleTail({ rule_id: null, rule_name: null, rule_label: 'A rule in Tasks' })).not.toMatch(/Notify/);
    expect(approvalRuleTail({ rule_id: 'f3c0aa10-0000-4000-8000-000000000001', rule_name: undefined, rule_label: 'A rule in Tasks' })).not.toMatch(/f3c0/);
  });
  it('GATED with no database either: nothing extra, the existing sentence stands', () => {
    expect(approvalRuleTail(WITHHELD_BARE)).toBeNull();
  });
  it('KEPT: no rule at all (an agent proposal, a deleted rule, an older API) is no tail, not an error', () => {
    expect(approvalRuleTail(NONE)).toBeNull();
    expect(approvalRuleTail({})).toBeNull();
    expect(approvalRuleTail(undefined)).toBeNull();
    expect(approvalRuleTail(null)).toBeNull();
    expect(approvalRuleTail({ rule_label: '   ' })).toBeNull();
    expect(ruleIsWithheld(NONE)).toBe(false);
  });
  it('KEPT: a rule whose own name starts with "A rule" is still given, not mistaken for withheld', () => {
    expect(approvalRuleTail({ rule_id: 'r', rule_name: 'A rule', rule_label: 'A rule' })).toBe('A rule');
  });
});

/** The real component, fed the approvals list the way the two Inbox surfaces feed it (same cache keys). */
const render = (rows: Array<{ id: string; status: string } & ApprovalRuleFields>) => {
  const qc = new QueryClient();
  qc.setQueryData(['approvals', 'ws', 'pending'], rows);
  qc.setQueryData(['approvals', 'ws', 'all'], rows);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(ApprovalRuleTail, { ws: 'ws', approvalId: 'a1' })));
};

describe('ApprovalRuleTail renders what the API gave', () => {
  it('given', () => expect(render([{ id: 'a1', status: 'pending', ...GIVEN }])).toContain('> Notify Finance<'));
  it('gated, with a database', () => expect(render([{ id: 'a1', status: 'pending', ...WITHHELD_DB }])).toContain('> a rule in Tasks<'));
  it('gated, no database: renders nothing', () => expect(render([{ id: 'a1', status: 'pending', ...WITHHELD_BARE }])).toBe(''));
  it('no rule: renders nothing', () => expect(render([{ id: 'a1', status: 'pending', ...NONE }])).toBe(''));
  it('an approval neither list knows: renders nothing (no guess)', () => expect(render([{ id: 'other', status: 'pending', ...GIVEN }])).toBe(''));
  it('a decided approval still names its rule (found in the all-list)', () => expect(render([{ id: 'a1', status: 'approved', ...GIVEN }])).toContain('Notify Finance'));
});

/** Both approval rows mount the SAME component right after the verb, and neither reads the raw fields itself. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
describe.each([
  ['the full-page inbox', '../../app/w/[ws]/inbox/page.tsx'],
  ['the inbox slide-over', '../inbox-panel.tsx'],
] as const)('%s', (_name, path) => {
  const text = read(path);
  it('mounts ApprovalRuleTail for an action approval, between the verb and the count', () => {
    expect(text).toMatch(/notificationVerb\(n\.type\)\}\s*\n\s*\{n\.type === 'action_approval_requested' && n\.ref_id && <ApprovalRuleTail ws=\{ws\} approvalId=\{n\.ref_id\} \/>\}\s*\n\s*\{n\.count > 1/);
  });
  it('the full-page inbox names the rule in the open row\'s header too', () => {
    if (!path.includes('inbox/page')) return;
    expect(text).toMatch(/notificationVerb\(selected\.type\)\}\s*\n\s*\{selected\.type === 'action_approval_requested' && selected\.ref_id && <ApprovalRuleTail ws=\{ws\} approvalId=\{selected\.ref_id\} \/>\}/);
  });
  it('never reads rule_name or rule_id (the helper owns the gate)', () => {
    expect(text).not.toMatch(/rule_name|rule_id/);
  });
});
