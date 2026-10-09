import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPY_RECORDS_MAX, copySelectionProblem } from './copy-limit';

describe('copySelectionProblem (#823)', () => {
  it('lets exactly the limit through: the cap is inclusive', () => {
    expect(copySelectionProblem(COPY_RECORDS_MAX)).toBeNull();
  });
  it('rejects one over, naming the number selected and the limit', () => {
    const p = copySelectionProblem(COPY_RECORDS_MAX + 1);
    expect(p).not.toBeNull();
    expect(p!.selected).toBe(201);
    expect(p!.limit).toBe(200);
    expect(p!.message).toContain('201');
    expect(p!.message).toContain('200');
  });
  it('passes every ordinary selection, including a single record and an empty one', () => {
    for (const n of [0, 1, 2, 50, 199]) expect(copySelectionProblem(n)).toBeNull();
  });
  it('states that nothing was copied, and offers no truncating path', () => {
    const p = copySelectionProblem(400)!;
    expect(p.message).toMatch(/nothing has been copied/i);
    expect(p.message).not.toMatch(/first \d+/i);
  });
});

describe('the mirrored bound matches the server (#823)', () => {
  it('reads the controller and fails if the two ever drift', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../api/src/copy-record/copy-record.controller.ts', import.meta.url)),
      'utf8',
    );
    const m = /record_ids:[^\n]*\.max\((\d+)\)/.exec(src);
    expect(m, 'could not find the record_ids bound in copy-record.controller.ts — did it move?').not.toBeNull();
    expect(Number(m![1])).toBe(COPY_RECORDS_MAX);
  });
});
