import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * #423 — every filter value editor must render STANDALONE.
 *
 * The bug this exists to prevent: `DateFilterInput` rendered a
 * `PopoverParentAnchor` (a Radix `PopoverAnchor`) with no `<Popover>` ancestor.
 * Radix throws on that, so picking `Created` on a filter destroyed the whole
 * route — and it threw the moment the control MOUNTED, not when it was used,
 * because the anchor was outside the `editing` guard.
 *
 * The toolbar mounts these controls exactly as this test does: directly, with
 * no wrapper. So "renders standalone" is not a synthetic constraint — it is the
 * real contract, and it was being violated by a component copied from the cell
 * editors, where the CALLER supplies the `<Popover>`.
 *
 * Driven off OPS_BY_TYPE itself rather than a hand-listed set, so a new field
 * type or a new operator widget is covered the day it is added.
 */

// view-toolbar pulls the API client and the table-view cell modules; neither is
// constructible outside the app runtime (same reason icon-picker.unit.test.ts
// stubs them). Only the pure render path is under test here.
vi.mock('@/lib/api', () => ({ api: {}, apiFetch: vi.fn() }));

const { OPS_BY_TYPE, FilterValueEditor, defaultValueFor, remapConditionToField } = await import('./view-toolbar');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

/**
 * The relation picker reads through react-query, and the app always mounts it
 * under a provider. Supplying one here keeps the test honest about the real
 * environment — the alternative (asserting it throws) would bake a harness
 * artefact in as if it were the contract.
 */
function renderStandalone(node: ReturnType<typeof createElement>): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
}

const MEMBERS = [{ id: 'u-1', name: 'Ada' }];

function fieldFor(type: string) {
  return {
    id: `f-${type}`,
    apiName: type,
    displayName: type,
    type,
    config: {},
    ...(type === 'relation' ? { relation: { target_database_id: 'db-2' } } : {}),
    options: [{ id: 'opt-1', label: 'One' }],
  } as never;
}

describe('#423 — every filter value editor renders standalone', () => {
  const cases = Object.entries(OPS_BY_TYPE).flatMap(([type, ops]) =>
    ops.map((op) => ({ type, op })),
  );

  it('covers every (field type × operator) pair the toolbar can offer', () => {
    // Guards the guard: if OPS_BY_TYPE were empty or failed to merge in the
    // system fields, every case below would vacuously pass.
    expect(cases.length).toBeGreaterThan(30);
    expect(cases.some((c) => c.type === 'created_at')).toBe(true);
  });

  for (const { type, op } of cases) {
    it(`${type} / ${op.op} (${op.input})`, () => {
      expect(() =>
        renderStandalone(
          createElement(FilterValueEditor, {
            field: fieldFor(type),
            members: MEMBERS,
            ws: 'ws-1',
            activeOp: op,
            condition: { field: type, op: op.op, value: defaultValueFor(op.input) },
            onChange: () => {},
          } as never),
        ),
      ).not.toThrow();
    });
  }
});

/**
 * #423 AC-5 — switching a condition's field between ANY two types leaves a
 * coherent condition.
 *
 * The reported symptom was `user` → `date` keeping `is any of`, which then
 * rendered the wrong widget. Every pair is exercised rather than the reported
 * one, because "which pairs did we think to check" is exactly the wrong
 * question to answer by hand.
 */
describe('#423 — retargeting a condition at another field', () => {
  const types = Object.keys(OPS_BY_TYPE);

  it('covers a real matrix', () => {
    expect(types.length).toBeGreaterThan(8);
  });

  for (const from of types) {
    for (const to of types) {
      it(`${from} → ${to} yields an operator valid for ${to}`, () => {
        const fromOp = OPS_BY_TYPE[from]![0]!;
        const next = remapConditionToField(
          { field: from, op: fromOp.op, value: defaultValueFor(fromOp.input) },
          fieldFor(to) as never,
        );
        expect(next, `${to} must offer at least one operator`).not.toBeNull();
        const valid = OPS_BY_TYPE[to]!.map((o) => o.op);
        expect(valid).toContain(next!.op);
        expect(next!.field).toBe(to);
      });
    }
  }

  it('refuses the switch outright when the target type has no operators', () => {
    // Rather than the old behaviour of keeping the previous op, which is the
    // only way this function could return something incoherent.
    const next = remapConditionToField(
      { field: 'text', op: 'contains', value: 'x' },
      fieldFor('a_type_with_no_ops') as never,
    );
    expect(next).toBeNull();
  });
});
