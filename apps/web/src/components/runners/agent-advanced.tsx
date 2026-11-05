'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MenuSelect } from '@/components/ui/menu-select';
import { apiErrorMessage } from '@/lib/api';
import { RUN_WITHOUT_AI } from '@/lib/runners/let-it-think-copy';
import {
  agentModelView,
  ESSENTIAL_TOOLS,
  EXTRA_TOOLS,
  leaveAll,
  modelControllable,
  modelProblem,
  modelToStore,
  plainProblem,
  readOnlyLine,
  toggleTool,
  toolsProblem,
  toolsView,
  FOLLOW_WORKSPACE,
} from '@/lib/runners/agent-settings';

const LINK = 'font-medium text-primary-text underline';

/**
 * Ticket #1180 (web) — the agent page's "Advanced · tools and model", closed until asked for (Dara's prototype v60).
 *
 * TOOLS: the 8 essentials are drawn ticked and fixed ("Always on"): the API offers them to every run and cannot store a removed
 * one. The extras are one click each and every click saves at once (the page has no Save button anywhere else); the stored text
 * is the comma-separated names, so a name this list does not carry (set through the API, or gone from the registry) is shown
 * under "Also saved" and can be removed, never dropped by a save. These are COST controls, not permissions, and the copy says so.
 *
 * MODEL: the product's own MenuSelect (never a native select). The first option follows the workspace default; "Reset to the
 * workspace default" stores null.
 *
 * `canEdit` is the Agents database's own bar (see `canEditAgentSettings`); without it everything is read-only with the one line
 * that says who manages the agent. `savedTools` / `savedModel` are the record's values; the component keeps its own copy while a
 * save is in flight so two quick clicks do not overwrite each other, and puts the old value back, with the server's words, on a refusal.
 */
export function AgentAdvanced({
  savedTools,
  savedModel,
  workspaceDefaultModel,
  canEdit,
  ownerName,
  brand,
  chosenTool,
  saving,
  onSave,
  runWithoutAi,
}: {
  savedTools: string | null;
  savedModel: string | null;
  workspaceDefaultModel: string | null;
  canEdit: boolean;
  ownerName: string | null;
  /** What the limit is called ("Claude"), or "AI" when the tool is not known to this viewer. */
  brand: string;
  chosenTool: string | null | undefined;
  saving: boolean;
  /** Resolves when the API accepted the write; rejects with the API's error. */
  onSave: (values: { tools?: string | null; model?: string | null }) => Promise<unknown>;
  /** Ticket #1210: the way back to Non-AI. Passed ONLY to the manager or an admin of a Your-own-AI agent; absent means no control is drawn. */
  runWithoutAi?: { onSwitch: () => void; pending: boolean };
}) {
  const [tools, setTools] = useState<string | null>(savedTools);
  const [model, setModel] = useState<string | null>(savedModel);
  const [problem, setProblem] = useState<string | null>(null);
  const inflight = useRef(0);

  // Follow the record when it changes underneath (another tab, a refetch), but never mid-save: that would flicker a click back.
  useEffect(() => {
    if (inflight.current === 0) setTools(savedTools);
  }, [savedTools]);
  useEffect(() => {
    if (inflight.current === 0) setModel(savedModel);
  }, [savedModel]);

  async function write(values: { tools?: string | null; model?: string | null }, revert: () => void) {
    const local = toolsProblem(values.tools ?? null) ?? ('model' in values ? modelProblem(values.model ?? null) : null);
    if (local) {
      setProblem(plainProblem(local));
      revert();
      return;
    }
    setProblem(null);
    inflight.current += 1;
    try {
      await onSave(values);
    } catch (e) {
      revert();
      setProblem(plainProblem(apiErrorMessage(e, 'Could not save. Try again.')));
    } finally {
      inflight.current -= 1;
    }
  }

  function changeTool(name: string, on: boolean) {
    const before = tools;
    const next = toggleTool(tools, name, on);
    setTools(next);
    void write({ tools: next }, () => setTools(before));
  }

  function backToEssentials() {
    const before = tools;
    const next = leaveAll(tools);
    setTools(next);
    void write({ tools: next }, () => setTools(before));
  }

  function pickModel(pick: string) {
    const before = model;
    const next = modelToStore(pick);
    setModel(next);
    void write({ model: next }, () => setModel(before));
  }

  const view = toolsView(tools);
  const modelUi = agentModelView(model, workspaceDefaultModel);
  const fixedModel = !modelControllable(chosenTool);

  return (
    <details className="group rounded-[var(--radius-card)] border border-border-default bg-card" data-testid="agent-advanced">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-[11px] text-body font-semibold text-ink-secondary [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
          ›
        </span>
        Advanced
        <span className="text-label font-normal text-muted">· tools and model</span>
      </summary>

      <div className="flex flex-col gap-4 border-t border-border-default px-3.5 py-3">
        <section aria-labelledby="agent-tools-h" data-testid="agent-tools">
          <h2 id="agent-tools-h" className="m-0 text-body font-bold text-ink">
            Tools
          </h2>
          <p className="mb-1 mt-0.5 text-label text-muted">The essentials:</p>
          <ul className="m-0 grid list-none grid-cols-1 gap-x-3 p-0 sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]" data-testid="agent-essentials">
            {ESSENTIAL_TOOLS.map((t) => (
              <li key={t.name}>
                <label className="flex items-start gap-2 py-[3px] text-body text-ink" title={`${t.name} · always on`}>
                  <input type="checkbox" checked disabled readOnly className="mt-[3px]" aria-label={`${t.label}, always on`} data-testid={`tool-${t.name}`} />
                  <span>{t.label}</span>
                </label>
              </li>
            ))}
          </ul>

          {view.all ? (
            <div className="mt-3 text-body text-ink" data-testid="tools-all">
              <p className="m-0">
                This agent is offered <b>every tool its role allows</b>. That makes each run much bigger on your {brand} limit.
              </p>
              {canEdit && (
                <button type="button" className={`${LINK} mt-1`} onClick={backToEssentials}>
                  Go back to the essentials
                </button>
              )}
            </div>
          ) : (
            <>
              <p className="mb-1 mt-3 text-label text-muted">Extras its role allows, one click each:</p>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="agent-extras">
                {EXTRA_TOOLS.map((t) => (
                  <li key={t.name}>
                    <label className={`flex items-start gap-2 py-[5px] text-body text-ink ${canEdit ? 'cursor-pointer' : ''}`} title={t.name}>
                      <input
                        type="checkbox"
                        className="mt-[3px]"
                        checked={view.ticked.has(t.name)}
                        disabled={!canEdit}
                        onChange={(e) => changeTool(t.name, e.target.checked)}
                        data-testid={`tool-${t.name}`}
                      />
                      <span>
                        {t.label}
                        <small className="block text-label text-muted">{t.why}</small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          {view.other.length > 0 && (
            <div className="mt-3" data-testid="tools-other">
              <p className="m-0 text-label text-muted">Also saved on this agent, not in the list above:</p>
              <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                {view.other.map((o) => (
                  <li key={o.name} className="flex flex-wrap items-baseline gap-x-2 text-body text-ink">
                    <code className="text-label">{o.name}</code>
                    {!o.known && <span className="text-label text-muted">no longer exists</span>}
                    {canEdit && (
                      <button type="button" className={`${LINK} text-label`} onClick={() => changeTool(o.name, false)} aria-label={`Remove ${o.name}`}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mb-0 mt-2 text-label leading-[1.45] text-muted">
            Each tool you add makes every run a little bigger on your {brand} limit, so add only what its job needs. It can never do more than its role allows.
          </p>
        </section>

        <section aria-labelledby="agent-model-h" data-testid="agent-model">
          <h2 id="agent-model-h" className="m-0 text-body font-bold text-ink">
            Model
          </h2>
          <div className="mt-1.5">
            {fixedModel ? (
              <>
                <MenuSelect label="Model" value="default" onChange={() => {}} options={[{ value: 'default', label: 'Cursor’s default' }]} disabled className="w-full max-w-none sm:w-auto sm:min-w-[17rem]" />
                <p className="mb-0 mt-1.5 text-label leading-[1.45] text-muted">Cursor picks the model from your Cursor plan.</p>
              </>
            ) : (
              <>
                <MenuSelect
                  label="Model"
                  value={modelUi.selected}
                  onChange={pickModel}
                  disabled={!canEdit}
                  options={modelUi.options.map((o) => ({ value: o.value, label: o.label, description: o.tradeoff }))}
                  className="w-full max-w-none sm:w-auto sm:min-w-[17rem]"
                  contentClassName="w-[19rem] max-w-[calc(100vw-2rem)]"
                />
                <p className="mb-0 mt-1.5 text-label leading-[1.45] text-muted" data-testid="model-note">
                  {modelUi.note}
                  {modelUi.reset && canEdit && (
                    <>
                      {' '}
                      <button type="button" className={LINK} onClick={() => pickModel(FOLLOW_WORKSPACE)}>
                        Reset to the workspace default
                      </button>
                      .
                    </>
                  )}{' '}
                  Smaller models use less of your {brand} limit.
                </p>
              </>
            )}
          </div>
        </section>

        {runWithoutAi && (
          <section aria-labelledby="agent-aimode-h" data-testid="agent-ai-mode">
            <h2 id="agent-aimode-h" className="m-0 text-body font-bold text-ink">
              {RUN_WITHOUT_AI.heading}
            </h2>
            <p className="mb-1.5 mt-0.5 text-label leading-[1.45] text-muted">{RUN_WITHOUT_AI.note}</p>
            <Button type="button" variant="secondary" size="sm" onClick={runWithoutAi.onSwitch} disabled={runWithoutAi.pending} data-testid="run-without-ai">
              {runWithoutAi.pending ? RUN_WITHOUT_AI.pending : RUN_WITHOUT_AI.button}
            </Button>
          </section>
        )}

        {problem && (
          <p className="m-0 break-words text-label text-warning-text" role="alert" data-testid="advanced-problem">
            {problem}
          </p>
        )}
        {!canEdit && (
          <p className="m-0 text-label text-muted" data-testid="advanced-readonly">
            {readOnlyLine(ownerName)}
          </p>
        )}
        {saving && <span className="sr-only" role="status">Saving</span>}
      </div>
    </details>
  );
}
