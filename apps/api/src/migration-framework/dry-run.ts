import type { DryRunReport, ImportWarning, NewFieldSpec } from './types';

/** First 100 warnings shown, rest only counted — a huge source can't blow up the response. */
const WARNING_CAP = 100;
/** First 5 mapped records previewed in the dry-run summary. */
const SAMPLE_CAP = 5;

/**
 * Accumulates a dry-run's per-record findings with the same caps every importer
 * needs — extracted out of MN-052's inline dry-run walk so Linear (and future
 * adapters) get the same warnings/sample shape for free instead of re-deriving it.
 */
export class DryRunBuilder {
  private warnings: ImportWarning[] = [];
  private warningsTotal = 0;
  private sample: Array<Record<string, unknown>> = [];
  /** #432 — NOT capped like warnings. A blocker list is a list of things the
   * user must decide on, and truncating it would hide a decision rather than
   * merely a detail. There are as many as there are fields, so it is bounded
   * anyway. */
  private blocking: Array<{ sourceKey: string; message: string }> = [];
  willCreate = 0;
  willUpdate = 0;
  newFields: NewFieldSpec[] = [];

  addWarning(w: ImportWarning): void {
    this.warningsTotal++;
    if (this.warnings.length < WARNING_CAP) this.warnings.push(w);
  }

  addBlocking(sourceKey: string, message: string): void {
    this.blocking.push({ sourceKey, message });
  }

  /** True while anything refuses the operation. */
  get isBlocked(): boolean {
    return this.blocking.length > 0;
  }

  addSample(record: Record<string, unknown>): void {
    if (this.sample.length < SAMPLE_CAP) this.sample.push(record);
  }

  build(): DryRunReport {
    return {
      will_create: this.willCreate,
      will_update: this.willUpdate,
      new_fields: this.newFields,
      warnings: this.warnings,
      warnings_total: this.warningsTotal,
      sample: this.sample,
      ...(this.blocking.length ? { blocking: this.blocking } : {}),
    };
  }
}
