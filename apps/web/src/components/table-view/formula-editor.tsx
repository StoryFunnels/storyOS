'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { FORMULA_FUNCTIONS, evaluateFormula, parseFormula, typecheck } from '@storyos/schemas';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { Field } from './use-table-data';

const FORMULA_TYPE_OF: Record<string, 'text' | 'number' | 'checkbox' | 'date' | null> = {
  number: 'number', checkbox: 'checkbox', date: 'date', created_at: 'date', updated_at: 'date',
  text: 'text', title: 'text', select: 'text', url: 'text', email: 'text', lookup: 'text',
  rollup: 'number',
};

export function FormulaEditor({
  ws,
  db,
  fields: dbFields,
  expression,
  onChange,
}: {
  ws: string;
  db: string;
  fields: Field[];
  expression: string;
  onChange: (expression: string) => void;
}) {
  const infos = dbFields
    .map((f) => {
      if (f.type === 'formula') {
        const rt = f.config['result_type'] as string | undefined;
        return rt ? { api_name: f.apiName, display_name: f.displayName, formula_type: rt as never } : null;
      }
      const ft = FORMULA_TYPE_OF[f.type];
      return ft ? { api_name: f.apiName, display_name: f.displayName, formula_type: ft } : null;
    })
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  const sample = useQuery({
    queryKey: ['formula-sample', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db }, query: { limit: 1 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ title: string; values: Record<string, unknown> }> }).data[0] ?? null;
    },
    staleTime: 60_000,
  });

  let feedback: { kind: 'ok' | 'error'; text: string } = { kind: 'ok', text: '' };
  if (expression.trim()) {
    try {
      const ast = parseFormula(expression, infos);
      const resultType = typecheck(ast, infos);
      let preview = '';
      if (sample.data) {
        const bag: Record<string, unknown> = { name: sample.data.title, ...sample.data.values };
        // Map select ids to labels so previews match server behavior.
        for (const f of dbFields) {
          if (f.type === 'select' && typeof bag[f.apiName] === 'string') {
            bag[f.apiName] = f.options?.find((o) => o.id === bag[f.apiName])?.label ?? bag[f.apiName];
          }
        }
        const value = evaluateFormula(ast, bag);
        preview = ` · preview (${sample.data.title || 'Untitled'}): ${value === null ? '—' : String(value)}`;
      }
      feedback = { kind: 'ok', text: `returns ${resultType === 'null' ? 'text' : resultType}${preview}` };
    } catch (error) {
      feedback = { kind: 'error', text: (error as Error).message };
    }
  }

  const [panel, setPanel] = useState<'none' | 'fields' | 'functions'>('none');
  const insert = (snippet: string) => onChange(expression + snippet);

  // Live autocomplete (MN-18): suggest fields inside {…} and functions on a bare word.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [ac, setAc] = useState<{ items: Array<{ label: string; hint: string; apply: () => void }>; index: number } | null>(null);
  const funcEntries = Object.entries(FORMULA_FUNCTIONS);

  function replaceRange(start: number, end: number, text: string) {
    onChange(expression.slice(0, start) + text + expression.slice(end));
    setAc(null);
    requestAnimationFrame(() => {
      const pos = start + text.length;
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  }

  function refreshSuggestions(value: string, caret: number) {
    const before = value.slice(0, caret);
    const brace = before.lastIndexOf('{');
    if (brace >= 0 && !before.slice(brace).includes('}')) {
      const partial = before.slice(brace + 1).toLowerCase();
      const items = infos
        .filter((f) => f.display_name.toLowerCase().includes(partial))
        .slice(0, 8)
        .map((f) => ({ label: f.display_name, hint: String(f.formula_type), apply: () => replaceRange(brace, caret, `{${f.display_name}}`) }));
      setAc(items.length ? { items, index: 0 } : null);
      return;
    }
    const word = before.match(/[a-zA-Z_][a-zA-Z0-9_]*$/)?.[0] ?? '';
    if (!word) return setAc(null);
    const start = caret - word.length;
    const items = funcEntries
      .filter(([name]) => name.toLowerCase().startsWith(word.toLowerCase()))
      .slice(0, 8)
      .map(([name, spec]) => ({
        label: name,
        hint: (spec as { doc?: string }).doc ?? '',
        apply: () => replaceRange(start, caret, name === 'now' || name === 'today' ? `${name}()` : `${name}(`),
      }));
    setAc(items.length ? { items, index: 0 } : null);
  }

  function onFormulaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!ac) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAc({ ...ac, index: (ac.index + 1) % ac.items.length }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAc({ ...ac, index: (ac.index - 1 + ac.items.length) % ac.items.length }); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); ac.items[ac.index]?.apply(); }
    else if (e.key === 'Escape') { e.preventDefault(); setAc(null); }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor="formula-src">Formula</Label>
        <div className="flex gap-1">
          <button
            type="button"
            className={cn('rounded px-1.5 py-0.5 text-[11px]', panel === 'fields' ? 'bg-active text-ink' : 'text-muted hover:bg-hover hover:text-ink')}
            onClick={() => setPanel((p) => (p === 'fields' ? 'none' : 'fields'))}
          >
            {'{ } Field'}
          </button>
          <button
            type="button"
            className={cn('rounded px-1.5 py-0.5 text-[11px]', panel === 'functions' ? 'bg-active text-ink' : 'text-muted hover:bg-hover hover:text-ink')}
            onClick={() => setPanel((p) => (p === 'functions' ? 'none' : 'functions'))}
          >
            ƒ Functions
          </button>
        </div>
      </div>
      <div className="relative">
        <textarea
          id="formula-src"
          ref={taRef}
          rows={3}
          className="w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-border-strong"
          placeholder={'if({Estimate} > 5, "big", "small")'}
          value={expression}
          onChange={(e) => {
            onChange(e.target.value);
            refreshSuggestions(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onFormulaKeyDown}
          onClick={(e) => refreshSuggestions(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setAc(null), 120)}
        />
        {ac && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-[var(--radius-card)] border border-border-strong bg-card shadow-lg">
            {ac.items.map((it, i) => (
              <button
                key={it.label}
                type="button"
                className={cn('flex w-full items-baseline gap-2 px-2 py-1 text-left', i === ac.index ? 'bg-active' : 'hover:bg-hover')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  it.apply();
                }}
              >
                <span className="font-mono text-[12px] text-ink">{it.label}</span>
                {it.hint && <span className="truncate text-[11px] text-muted">{it.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {panel === 'fields' && (
        <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card p-1.5">
          {infos.length === 0 && <span className="px-1 text-[12px] text-faint">No referenceable fields yet.</span>}
          {infos.map((f) => (
            <button
              key={f.api_name}
              type="button"
              className="rounded bg-hover px-1.5 py-0.5 text-[12px] text-ink hover:bg-active"
              onClick={() => {
                // If the user just typed "{", complete it; otherwise insert a full {Field}.
                onChange(expression.endsWith('{') ? `${expression}${f.display_name}}` : `${expression}{${f.display_name}}`);
                setPanel('none');
              }}
            >
              {f.display_name}
            </button>
          ))}
        </div>
      )}
      {panel === 'functions' && (
        <div className="max-h-40 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card p-1">
          {Object.entries(FORMULA_FUNCTIONS).map(([name, spec]) => (
            <button
              key={name}
              type="button"
              title={spec.example}
              className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-hover"
              onClick={() => {
                const noArgs = name === 'now' || name === 'today';
                insert(noArgs ? `${name}()` : `${name}(`);
                setPanel('none');
              }}
            >
              <span className="font-mono text-[12px] text-ink">{spec.example}</span>
              <span className="text-[11px] text-muted">{spec.doc}</span>
            </button>
          ))}
        </div>
      )}
      <p className={cn('text-[12px]', feedback.kind === 'error' ? 'text-error' : 'text-muted')}>
        {feedback.text || 'Reference fields as {Field Name}. Use the buttons above to insert fields and functions.'}
      </p>
      <a
        href="https://github.com/StoryFunnels/storyOS/blob/main/docs/product/formulas.md"
        target="_blank"
        rel="noreferrer"
        className="self-start text-[12px] text-info underline-offset-2 hover:underline"
      >
        Learn formulas →
      </a>
    </div>
  );
}
