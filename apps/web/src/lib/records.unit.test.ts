import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/views/empty-state';
import { databaseNoun, pluralNoun } from './records';

/** Ticket #1223 AC3 — the noun is drawn from real database names; a trailing "s" is not a plural rule. */
describe('databaseNoun', () => {
  const table: Array<[string, string]> = [
    ['Companies', 'company'],
    ['Addresses', 'address'],
    ['Address', 'address'],
    ['Status', 'status'],
    ['Statuses', 'status'],
    ['Clients', 'client'],
    ['Leads', 'lead'],
    ['Issues', 'issue'],
    ['Sprints', 'sprint'],
    ['Epics', 'epic'],
    ['Tasks', 'task'],
    ['Boxes', 'box'],
    ['Batches', 'batch'],
    ['Invoices', 'invoice'],
    ['Phases', 'phase'],
    ['Businesses', 'business'],
    ['Entries', 'entry'],
    ['Movies', 'movie'],
    ['Series', 'series'],
    ['News', 'news'],
    ['Analytics', 'analytics'],
    ['Sales Companies', 'sales company'],
    ['  Clients  ', 'client'],
    ['OS', 'os'],
    ['Data', 'data'],
  ];
  it.each(table)('%s → %s', (name, noun) => expect(databaseNoun(name)).toBe(noun));
  it('falls back to "item" with no name', () => {
    expect(databaseNoun(null)).toBe('item');
    expect(databaseNoun('  ')).toBe('item');
  });
  it('never produces the broken stems the old rule did', () => {
    for (const bad of ['companie', 'addres', 'statu', 'statuse', 'boxe']) {
      for (const [name] of table) expect(databaseNoun(name)).not.toBe(bad);
    }
  });
});

describe('pluralNoun', () => {
  it('one is the noun itself; other counts take the right plural', () => {
    expect(pluralNoun('company', 1)).toBe('company');
    expect(pluralNoun('company', 3)).toBe('companies');
    expect(pluralNoun('address', 2)).toBe('addresses');
    expect(pluralNoun('status', 2)).toBe('statuses');
    expect(pluralNoun('box', 2)).toBe('boxes');
    expect(pluralNoun('day', 2)).toBe('days');
    expect(pluralNoun('task', 0)).toBe('tasks');
    expect(pluralNoun('series', 2)).toBe('series');
    expect(pluralNoun('movie', 2)).toBe('movies');
  });
  it('round-trips: the plural of a database noun is the database name again', () => {
    for (const name of ['Companies', 'Addresses', 'Statuses', 'Clients', 'Leads', 'Issues', 'Boxes', 'Batches', 'Entries', 'Movies', 'Series', 'News', 'Tasks']) {
      expect(pluralNoun(databaseNoun(name), 2)).toBe(name.toLowerCase());
    }
  });
});

describe('callers that pluralise the noun themselves', () => {
  it('the empty state says "companies", not "companys" (it used to append "s" to the broken stem)', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { noun: databaseNoun('Companies') }));
    expect(html).toContain('New companies will show up here.');
    expect(html).not.toMatch(/companys|companie\b/);
  });
});
