import { describe, expect, it, vi } from 'vitest';
import type { AiCreditsService } from '../billing/ai-credits.service';
import { AI_CREDIT_MARKUP_MULTIPLIER, MANAGED_AI_PROPOSE_PLACEHOLDER_COST_CENTS } from '../billing/plans';
import {
  ManagedAiProposer,
  NonAiProposer,
  YourOwnAiProposer,
  pickProposer,
} from './architect-proposer';
import type { ManagedAiClient } from './managed-ai-client';

/**
 * MN-217c (#246): the two real proposers behind the `PlanProposer` seam —
 * `YourOwnAiProposer` (unmetered by construction, no model call) and
 * `ManagedAiProposer` (metered, a real call through `ManagedAiClient`).
 * Unit-level so the metering and validation logic is provable without a
 * real network call or a real Postgres-backed ledger — see architect.test.ts
 * for the full HTTP-level propose/build flow.
 */

const LEAD_DRAFT = {
  summary: 'x',
  scenario: 'lead-intake',
  databases: [{ name: 'Leads', space: 'Sales', fields: [] }],
  relations: [],
  states: [],
  agents: [],
  triggers: [],
};

function fakeAiCredits(canUse: boolean): AiCreditsService & { recordUsage: ReturnType<typeof vi.fn> } {
  return {
    canUseManagedAi: vi.fn().mockResolvedValue(canUse),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  } as unknown as AiCreditsService & { recordUsage: ReturnType<typeof vi.fn> };
}

function fakeClient(text: string, tokensIn = 100, tokensOut = 50): ManagedAiClient {
  return { complete: vi.fn().mockResolvedValue({ text, tokensIn, tokensOut }) };
}

describe('pickProposer (#246) — routes by the CALLER’s mode, defaults unchanged', () => {
  const deps = { aiCredits: fakeAiCredits(true) };

  it('mode omitted, or "non_ai", is the pre-#246 default: the free scenario matcher', () => {
    expect(pickProposer({ workspaceId: 'w', goal: 'x' }, deps)).toBeInstanceOf(NonAiProposer);
    expect(pickProposer({ workspaceId: 'w', goal: 'x', mode: 'non_ai' }, deps)).toBeInstanceOf(
      NonAiProposer,
    );
  });

  it('"your_own_ai" picks the BYO-AI proposer', () => {
    expect(pickProposer({ workspaceId: 'w', goal: 'x', mode: 'your_own_ai' }, deps)).toBeInstanceOf(
      YourOwnAiProposer,
    );
  });

  it('"storyos_ai" picks the managed proposer', () => {
    expect(pickProposer({ workspaceId: 'w', goal: 'x', mode: 'storyos_ai' }, deps)).toBeInstanceOf(
      ManagedAiProposer,
    );
  });
});

describe('YourOwnAiProposer (#246) — never calls a model, unmetered by construction', () => {
  it('declares planClass "your_own_ai"', () => {
    expect(new YourOwnAiProposer().planClass).toBe('your_own_ai');
  });

  it('refuses with a clear 422 when no draft is supplied — it does not improvise either', async () => {
    await expect(
      new YourOwnAiProposer().propose({ workspaceId: 'w', goal: 'reconcile the ledger' }),
    ).rejects.toThrow(/requires `draft`/);
  });

  it('422s a malformed supplied draft, naming what is wrong', async () => {
    await expect(
      new YourOwnAiProposer().propose({
        workspaceId: 'w',
        goal: 'x',
        suppliedDraft: { summary: 'missing everything else' },
      }),
    ).rejects.toThrow(/not a valid Architect plan draft/);
  });

  it('a database entry carrying `action` is rejected — that split is not the caller’s to break', async () => {
    await expect(
      new YourOwnAiProposer().propose({
        workspaceId: 'w',
        goal: 'x',
        suppliedDraft: {
          ...LEAD_DRAFT,
          databases: [{ action: 'create', name: 'Leads', space: 'Sales', fields: [] }],
        },
      }),
    ).rejects.toThrow(/not a valid Architect plan draft/);
  });

  it('returns a valid supplied draft verbatim — the reasoning already happened outside this process', async () => {
    const result = await new YourOwnAiProposer().propose({
      workspaceId: 'w',
      goal: 'reconcile the ledger against the bank statement nightly',
      suppliedDraft: LEAD_DRAFT,
    });
    expect(result).toEqual(LEAD_DRAFT);
  });
});

describe('ManagedAiProposer (#246) — a real call, gated and metered', () => {
  it('declares planClass "storyos_ai"', () => {
    expect(new ManagedAiProposer(undefined, fakeAiCredits(true)).planClass).toBe('storyos_ai');
  });

  it('422s when unconfigured (no client) — before even checking credits', async () => {
    const aiCredits = fakeAiCredits(true);
    await expect(
      new ManagedAiProposer(undefined, aiCredits).propose({ workspaceId: 'w', goal: 'x' }),
    ).rejects.toThrow(/not configured/);
    expect(aiCredits.canUseManagedAi).not.toHaveBeenCalled();
  });

  it('422s when the workspace has no usable credit — gated BEFORE the model call', async () => {
    const client = fakeClient(JSON.stringify(LEAD_DRAFT));
    const aiCredits = fakeAiCredits(false);
    await expect(
      new ManagedAiProposer(client, aiCredits).propose({ workspaceId: 'w', goal: 'x' }),
    ).rejects.toThrow(/no usable credit balance/);
    expect(client.complete).not.toHaveBeenCalled();
    expect(aiCredits.recordUsage).not.toHaveBeenCalled();
  });

  it('a goal outside the scenario library produces a sensible concrete plan (#246 AC) — and is metered', async () => {
    const novelPlan = {
      summary: 'Reconcile the ledger nightly against the bank statement and flag mismatches.',
      scenario: 'ledger-reconciliation',
      databases: [
        {
          name: 'Ledger Entries',
          space: 'Finance',
          fields: [{ name: 'Amount', type: 'number' }],
        },
      ],
      relations: [],
      states: [],
      agents: [
        {
          name: 'Reconciliation Assistant',
          goal: 'Flag mismatches nightly',
          scopes: ['read'],
          approval_policy: [],
          target_databases: ['Ledger Entries'],
        },
      ],
      triggers: [],
    };
    const client = fakeClient(JSON.stringify(novelPlan), 1234, 567);
    const aiCredits = fakeAiCredits(true);

    const result = await new ManagedAiProposer(client, aiCredits).propose({
      workspaceId: 'ws1',
      goal: 'reconcile the general ledger against the bank statement every night',
    });

    expect(result).toEqual(novelPlan);
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect((client.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      'reconcile the general ledger',
    );

    // Metered with REAL token counts (unlike the still-stubbed runtime seam).
    expect(aiCredits.recordUsage).toHaveBeenCalledWith('ws1', {
      tokensIn: 1234,
      tokensOut: 567,
      ourCostCents: MANAGED_AI_PROPOSE_PLACEHOLDER_COST_CENTS,
      creditsChargedCents: MANAGED_AI_PROPOSE_PLACEHOLDER_COST_CENTS * AI_CREDIT_MARKUP_MULTIPLIER,
    });
  });

  it('422s cleanly on non-JSON output — meters the call anyway, builds nothing', async () => {
    const client = fakeClient('not json at all');
    const aiCredits = fakeAiCredits(true);
    await expect(
      new ManagedAiProposer(client, aiCredits).propose({ workspaceId: 'ws1', goal: 'x' }),
    ).rejects.toThrow(/did not return valid JSON/);
    expect(aiCredits.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('422s cleanly on a hallucinated plan that fails schema validation — meters the call anyway', async () => {
    const client = fakeClient(JSON.stringify({ summary: 'x' })); // missing scenario, etc.
    const aiCredits = fakeAiCredits(true);
    await expect(
      new ManagedAiProposer(client, aiCredits).propose({ workspaceId: 'ws1', goal: 'x' }),
    ).rejects.toThrow(/produced an invalid plan/);
    expect(aiCredits.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('422s when the model claims `action` on a database — that split is never the model’s to make', async () => {
    const client = fakeClient(
      JSON.stringify({
        ...LEAD_DRAFT,
        databases: [{ action: 'create', name: 'Leads', space: 'Sales', fields: [] }],
      }),
    );
    const aiCredits = fakeAiCredits(true);
    await expect(
      new ManagedAiProposer(client, aiCredits).propose({ workspaceId: 'ws1', goal: 'x' }),
    ).rejects.toThrow(/produced an invalid plan/);
  });
});
