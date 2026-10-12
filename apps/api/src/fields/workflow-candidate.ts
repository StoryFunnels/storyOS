/**
 * #598 — does a single-select look like a lifecycle ("status") field, i.e. a candidate to become the
 * database's one `workflow` field (#172)? A pure heuristic, kept apart from the DB code so its
 * judgement is testable on its own: the scan REPORTS, a person or an agent decides, and a wrong
 * guess here only ever costs a suggestion that is not taken.
 *
 * Two independent signals, because each alone is wrong in a common case:
 *  - the NAME ("Status", "Stage"...): a RAG column called "Status" (Red/Amber/Green) matches by name
 *    and is not a lifecycle;
 *  - the OPTION LABELS ("To do / In progress / Done"): a column called "Column" with those labels is a
 *    lifecycle with no helpful name, while "Priority" (Low/Medium/High) shares NEITHER signal.
 * Both together is high confidence. One alone is lower, and says which one it was.
 */

/** Field names that mean "where is this in its life". Compared whole-word, case-insensitively. */
const NAME_TOKENS = ['status', 'state', 'stage', 'phase', 'lifecycle', 'progress', 'workflow', 'pipeline'];

/**
 * Labels a lifecycle column typically carries. Matched on the normalised whole label ("In Progress"
 * and "in-progress" and "in_progress" are one label), never as a substring: "Done deal" is not "done".
 */
const LIFECYCLE_LABELS = new Set([
  'backlog', 'todo', 'to do', 'new', 'open', 'planned', 'not started', 'ready', 'triage', 'inbox',
  'in progress', 'doing', 'started', 'active', 'wip', 'in development', 'in review', 'review', 'testing', 'qa',
  'blocked', 'on hold', 'waiting', 'paused',
  'done', 'complete', 'completed', 'closed', 'resolved', 'shipped', 'released', 'finished',
  "won't do", 'wont do', 'cancelled', 'canceled', 'archived', 'rejected', 'duplicate',
]);

export type Confidence = 'high' | 'medium' | 'low';

export interface WorkflowCandidateScore {
  confidence: Confidence;
  reasons: string[];
  /** For ordering candidates inside one database; not a probability. */
  score: number;
}

const normalise = (s: string): string => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

export function nameLooksLikeLifecycle(displayName: string, apiName: string): string | null {
  for (const raw of [displayName, apiName]) {
    const words = normalise(raw).split(' ');
    const hit = NAME_TOKENS.find((t) => words.includes(t));
    if (hit) return hit;
  }
  return null;
}

export function lifecycleLabelsIn(optionLabels: string[]): string[] {
  return optionLabels.filter((l) => LIFECYCLE_LABELS.has(normalise(l)));
}

/** Null when it does not look like a lifecycle at all (the usual answer: Priority, Type, Owner team...). */
export function scoreWorkflowCandidate(field: {
  displayName: string;
  apiName: string;
  optionLabels: string[];
}): WorkflowCandidateScore | null {
  const nameHit = nameLooksLikeLifecycle(field.displayName, field.apiName);
  const labelHits = lifecycleLabelsIn(field.optionLabels);
  const labelShare = field.optionLabels.length === 0 ? 0 : labelHits.length / field.optionLabels.length;
  const reasons: string[] = [];
  if (nameHit) reasons.push(`named "${field.displayName}" (a lifecycle word: ${nameHit})`);
  if (labelHits.length >= 2) {
    reasons.push(`${labelHits.length} of ${field.optionLabels.length} options are lifecycle labels (${labelHits.slice(0, 4).join(', ')})`);
  }
  const strongLabels = labelHits.length >= 3 && labelShare >= 0.5;
  const someLabels = labelHits.length >= 2;

  let confidence: Confidence | null = null;
  if (nameHit && someLabels) confidence = 'high';
  else if (strongLabels) confidence = 'medium';
  else if (nameHit) {
    confidence = 'low';
    reasons.push('only the NAME matches: the options do not look like a lifecycle (a RAG or rating column is also called "Status")');
  } else if (someLabels && labelShare >= 0.5) confidence = 'low';
  if (!confidence) return null;
  const rank = { high: 3, medium: 2, low: 1 }[confidence];
  return { confidence, reasons, score: rank * 100 + Math.round(labelShare * 10) };
}
