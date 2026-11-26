import { describe, expect, it } from 'vitest';
import { createLogBudget, MAX_REPORT_BYTES, originOnly, parseCspReport } from './csp-report';

describe('#1238 CSP violation reports', () => {
  const legacy = JSON.stringify({
    'csp-report': {
      'document-uri': 'https://app.example.test/f/SECRET-SHARE-TOKEN?invite=SECRET-INVITE',
      'blocked-uri': 'https://evil.example/x.js?token=abc',
      'effective-directive': 'script-src-elem',
      'violated-directive': 'script-src',
      'source-file': 'https://app.example.test/_next/static/chunk.js',
      'line-number': 12.7,
      disposition: 'enforce',
    },
  });

  it('reads the legacy report-uri body and keeps origins only: no path, query or token', () => {
    const [v] = parseCspReport(legacy);
    expect(v).toEqual({
      directive: 'script-src-elem',
      blocked: 'https://evil.example',
      page: 'https://app.example.test',
      source: 'https://app.example.test',
      line: 12,
      disposition: 'enforce',
    });
    expect(JSON.stringify(v)).not.toMatch(/SECRET|token=|\/x\.js/);
  });

  it('reads the Reporting API body', () => {
    const body = JSON.stringify([
      { type: 'csp-violation', body: { documentURL: 'https://a.example/w/1', blockedURL: 'inline', effectiveDirective: 'style-src-attr', lineNumber: 3 } },
      { type: 'deprecation', body: { id: 'x' } },
    ]);
    expect(parseCspReport(body)).toEqual([
      { directive: 'style-src-attr', blocked: 'inline', page: 'https://a.example', source: null, line: 3, disposition: null },
    ]);
  });

  it('survives hostile input: not JSON, wrong shapes, oversize, injected newlines', () => {
    expect(parseCspReport('not json')).toEqual([]);
    expect(parseCspReport('null')).toEqual([]);
    expect(parseCspReport('{"csp-report": 5}')).toEqual([]);
    expect(parseCspReport(JSON.stringify({ 'csp-report': { 'x': 'y'.repeat(MAX_REPORT_BYTES) } }))).toEqual([]);
    const [v] = parseCspReport(JSON.stringify({ 'csp-report': { 'effective-directive': 'a"}\n{"event":"forged' } }));
    expect(v!.directive).not.toMatch(/[\n"{}]/);
    expect(parseCspReport(JSON.stringify(Array.from({ length: 50 }, () => ({ type: 'csp-violation', body: {} })))).length).toBe(10);
  });

  it('cuts every URL down to its origin and names the pseudo-values', () => {
    expect(originOnly('https://a.example:8443/p?q=1#h')).toBe('https://a.example:8443');
    expect(originOnly('data:image/png;base64,AAAA')).toBe('data');
    expect(originOnly('eval')).toBe('eval');
    expect(originOnly('::::')).toBe('invalid');
    expect(originOnly(undefined)).toBe('none');
  });

  it('the log budget refuses past its limit and refills each window', () => {
    let t = 0;
    const may = createLogBudget(2, 1000, () => t);
    expect([may(), may(), may()]).toEqual([true, true, false]);
    t = 1000;
    expect(may()).toBe(true);
  });
});
