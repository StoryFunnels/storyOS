import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #869 AC4 — a decided approval never shows live Approve/Reject. The controls on both Inbox
 * surfaces must sit inside <ApprovalGate>, so a later edit cannot re-expose them by moving the block.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const surfaces = [
  ['the full-page inbox', '../../app/w/[ws]/inbox/page.tsx'],
  ['the inbox slide-over', '../inbox-panel.tsx'],
] as const;

const outsideGate = (text: string) => text.replace(/<ApprovalGate[\s\S]*?<\/ApprovalGate>/g, '');

describe.each(surfaces)('%s', (_name, path) => {
  const text = read(path);
  it('wraps the action-approval controls in the gate', () => {
    expect(text).toMatch(/<ApprovalGate ws=\{ws\} approvalId=\{[^}]+\}>/);
    const gated = text.match(/<ApprovalGate[\s\S]*?<\/ApprovalGate>/)![0];
    expect(gated).toMatch(/verdict: 'approve'/);
    expect(gated).toMatch(/verdict: 'reject'/);
  });
  it('has no other path to resolveApproval.mutate outside the gate', () => {
    expect(outsideGate(text)).not.toMatch(/resolveApproval\.mutate/);
  });
  it('tags the list row once the approval is decided', () => {
    expect(text).toMatch(/<ApprovalRowTag ws=\{ws\}/);
  });
});
