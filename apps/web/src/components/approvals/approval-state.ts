/**
 * Ticket #869 — what the Inbox may offer for an approval.
 *
 * The notification row says "needs your approval" forever, because a notification is an event, not
 * a state. Whether the approval is STILL waiting lives on the approval itself (`status`), which the
 * API already returns (`GET /approvals`). The Inbox used to ignore it, so a decided approval kept
 * live Approve/Reject buttons that the server then refused (or, before the server fix, accepted and
 * ignored). The server's refusal is what makes it correct; this is what makes it usable.
 *
 * Read from the approval's own status, never inferred from the notification or its age.
 */
export interface ApprovalRow {
  id: string;
  status: string;
  decided_by?: string | null;
  decided_at?: string | null;
  reason?: string | null;
}

export type ApprovalView =
  | { kind: 'loading' }
  | { kind: 'pending' }
  | { kind: 'decided'; status: 'approved' | 'rejected' | 'expired' | 'unknown'; by: string | null; at: string | null; reason: string | null };

/**
 * `pending` is the list of approvals the API says are pending; `all` is the list of every approval
 * (newest 100, no status filter). Controls are offered ONLY for an approval one of them says is
 * pending. One the API does not list at all (older than the newest 100, or not visible to this
 * person) is reported as no longer waiting rather than guessed pending: a missing live control is
 * recoverable, a live control on a decided approval is the defect.
 */
export function approvalView(input: { id: string; pending: ApprovalRow[] | undefined; all: ApprovalRow[] | undefined }): ApprovalView {
  const { id, pending, all } = input;
  if (pending?.some((a) => a.id === id)) return { kind: 'pending' };
  const found = all?.find((a) => a.id === id);
  if (found?.status === 'pending') return { kind: 'pending' };
  if (!pending || !all) return { kind: 'loading' };
  const status = found?.status;
  return {
    kind: 'decided',
    status: status === 'approved' || status === 'rejected' || status === 'expired' ? status : 'unknown',
    by: found?.decided_by ?? null,
    at: found?.decided_at ?? null,
    reason: found?.reason ?? null,
  };
}

/**
 * `namesReady` is false while the member list is still loading: saying "by someone" for a person
 * whose name is about to arrive is a wrong statement, so until then the line just omits who.
 */
export function decidedSummary(
  view: Extract<ApprovalView, { kind: 'decided' }>,
  nameOf: (userId: string) => string | undefined,
  formatDate: (iso: string) => string,
  namesReady = true,
): string {
  const who = view.by && namesReady ? (nameOf(view.by) ?? 'someone') : null;
  const when = view.at ? ` · ${formatDate(view.at)}` : '';
  switch (view.status) {
    case 'approved':
      return `Approved${who ? ` by ${who}` : ''}${when}`;
    case 'rejected':
      return `Rejected${who ? ` by ${who}` : ''}${when}${view.reason ? ` — ${view.reason}` : ''}`;
    case 'expired':
      return 'Expired without a decision';
    default:
      return 'This approval is no longer waiting for a decision';
  }
}
