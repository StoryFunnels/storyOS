import { describe, expect, it } from 'vitest';
import type { Field } from '../table-view/use-table-data';
import { splitCardFields } from './list-fields';

const field = (apiName: string, type: string): Field => ({ id: apiName, apiName, displayName: apiName, type, config: {}, isSystem: false });

/** #1115 — which card fields lead the title and which follow it. */
describe('splitCardFields', () => {
  it('selects and the first text field lead; sets, people, figures and further text follow', () => {
    const fields = [field('priority', 'select'), field('identifier', 'text'), field('labels', 'relation'), field('assignee_name', 'text'), field('estimate', 'number')];
    const { leading, trailing } = splitCardFields(fields, undefined);
    expect(leading.map((f) => f.apiName)).toEqual(['priority', 'identifier']);
    expect(trailing.map((f) => f.apiName)).toEqual(['labels', 'assignee_name', 'estimate']);
  });
  it("the row's own state field is in neither — its glyph stands before the title", () => {
    const fields = [field('state', 'workflow'), field('priority', 'select')];
    const { leading, trailing } = splitCardFields(fields, 'state');
    expect(leading.map((f) => f.apiName)).toEqual(['priority']);
    expect(trailing).toEqual([]);
  });
  it('keeps the card order inside each side', () => {
    const fields = [field('labels', 'relation'), field('identifier', 'text'), field('sprint', 'relation'), field('priority', 'select')];
    const { leading, trailing } = splitCardFields(fields, undefined);
    expect(leading.map((f) => f.apiName)).toEqual(['identifier', 'priority']);
    expect(trailing.map((f) => f.apiName)).toEqual(['labels', 'sprint']);
  });
});
