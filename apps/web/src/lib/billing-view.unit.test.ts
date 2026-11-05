import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BILLING_UNAVAILABLE,
  OWN_AI_COPY,
  canStartTrial,
  cloudBillingSentences,
  upgradeTargets,
  type BillingPlan,
} from './billing-view';

const page = readFileSync(fileURLToPath(new URL('../app/w/[ws]/settings/billing/page.tsx', import.meta.url)), 'utf8');

describe('which upgrades a plan is offered (#1186 AC4)', () => {
  const offered = (plan: BillingPlan) => upgradeTargets(plan);

  it('Free is offered Pro and Business; Pro only Business', () => {
    expect(offered('free')).toEqual(['pro', 'business']);
    expect(offered('pro')).toEqual(['business']);
  });

  it('Business and Enterprise are offered nothing: no Upgrade button on Enterprise', () => {
    expect(offered('business')).toEqual([]);
    expect(offered('enterprise')).toEqual([]);
  });

  it('a plan it does not know is offered nothing', () => {
    expect(upgradeTargets('platinum' as BillingPlan)).toEqual([]);
  });

  it('the trial is for a Free workspace that has never had one', () => {
    expect(canStartTrial('free', null)).toBe(true);
    expect(canStartTrial('free', '2026-10-01T00:00:00Z')).toBe(false);
    for (const p of ['pro', 'business', 'enterprise'] as const) expect(canStartTrial(p, null)).toBe(false);
  });

  it('the page draws its buttons from upgradeTargets, not from its own plan comparisons', () => {
    expect(page).toContain('upgradeTargets(b.plan)');
    expect(page).not.toMatch(/b\.plan !== '(pro|business)'/);
  });
});

describe('the copy, on cloud and on self-managed (#1186 AC4)', () => {
  const forbidden = [/under API tokens/i, /self-host/i, /self-managed/i, /\bhosted instance\b/i];

  it('CLOUD: no fixed sentence points at API tokens or speaks of self-hosting', () => {
    for (const { where, text } of cloudBillingSentences()) {
      for (const re of forbidden) expect(text, `${where}: ${text}`).not.toMatch(re);
    }
  });

  it('CLOUD: the own-AI card sends a person to Connect your AI, with a link, and says it holds on any plan', () => {
    expect(OWN_AI_COPY.body).toContain('on any plan');
    expect(OWN_AI_COPY.setUpPrefix).toBe('Set one up under');
    expect(OWN_AI_COPY.linkLabel).toBe('Connect your AI');
    expect(page).toContain("settingsPageHref(ws, 'connect-ai')");
  });

  it('CLOUD: the page file holds no copy of its own that could reintroduce the old wording', () => {
    // Code and strings only: a comment may explain the rule by naming it.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of forbidden) expect(code).not.toMatch(re);
  });

  it('SELF-MANAGED: says billing is a cloud feature, once, and offers no button (the CTAs are absent in that branch)', () => {
    expect(BILLING_UNAVAILABLE).toBe('Billing is a cloud feature and isn’t available on this self-hosted instance.');
    const branch = page.slice(page.indexOf('if (!b.enabled)'), page.indexOf('const trialDaysLeft'));
    expect(branch).toContain('BILLING_UNAVAILABLE');
    expect(branch).not.toMatch(/<Button|Upgrade|Manage billing|checkout|startTrial/);
  });

  it('the self-hosting sentence is not part of the cloud list', () => {
    expect(cloudBillingSentences().some((s) => s.text === BILLING_UNAVAILABLE)).toBe(false);
  });
});
