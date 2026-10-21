import { describe, expect, it } from 'vitest';
import { choicePreviewHeading } from './change-type-preview';

const opt = (label: string) => ({ label, color: 'blue', records: 1 });

describe('choicePreviewHeading (#958)', () => {
  it('counts the options that will be created', () => {
    expect(choicePreviewHeading({ options: [opt('backlog'), opt('started')] })).toBe('2 options will be created');
    expect(choicePreviewHeading({ options: [opt('backlog')] })).toBe('1 option will be created');
  });
  it('names the empty records, with the right plural', () => {
    expect(choicePreviewHeading({ options: [opt('a'), opt('b')], empty_records: 3 })).toBe(
      '2 options will be created, 3 records are empty and stay empty',
    );
    expect(choicePreviewHeading({ options: [opt('a')], empty_records: 1 })).toBe(
      '1 option will be created, 1 record is empty and stays empty',
    );
  });
  it('says so when there is nothing to create instead of "0 option(s)"', () => {
    expect(choicePreviewHeading({ options: [], empty_records: 4 })).toBe('No options to create: all 4 records are empty');
    expect(choicePreviewHeading({ options: [], empty_records: 1 })).toBe('No options to create: all 1 record is empty');
    expect(choicePreviewHeading({ options: [] })).toBe('No options to create: there are no records');
  });
});
