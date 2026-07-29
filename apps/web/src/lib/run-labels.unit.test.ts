import { describe, expect, it } from 'vitest';
import {
  actionKindLabel,
  actionStatusLabel,
  approvalStatusLabel,
  formatDuration,
  humanizeSlug,
  runActionSummaryText,
  runStatusLabel,
  runStepSummary,
  triggerKindLabel,
} from './run-labels';

// A raw slug looks like a machine enum value: has an underscore/dot, or is a
// short all-lowercase token. If a label still looks like that, humanization
// failed and we'd be showing the user a slug.
function looksLikeRawSlug(label: string): boolean {
  return /_|\./.test(label) || (/^[a-z]+$/.test(label) && label.length > 2);
}

describe('runStatusLabel', () => {
  // Every run status the API can emit (runs.service KNOWN_STATUSES + db schema).
  const RUN_STATUSES = ['ok', 'error', 'running', 'skipped', 'skipped_quota', 'skipped_cap', 'pending_approval'];

  it('maps known statuses to friendly copy, no raw slug', () => {
    for (const s of RUN_STATUSES) {
      const label = runStatusLabel(s);
      expect(label).not.toBe(s);
      expect(looksLikeRawSlug(label)).toBe(false);
    }
  });

  it('uses specific quota wording', () => {
    expect(runStatusLabel('skipped_quota')).toBe('Skipped — over quota');
    expect(runStatusLabel('error')).toBe('Failed');
  });

  it('humanizes an unmapped status rather than showing the slug', () => {
    expect(runStatusLabel('some_new_status')).toBe('Some New Status');
  });
});

describe('actionStatusLabel', () => {
  const ACTION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'pending_approval'];

  it('maps every job status to friendly copy', () => {
    for (const s of ACTION_STATUSES) {
      const label = actionStatusLabel(s);
      expect(looksLikeRawSlug(label)).toBe(false);
    }
  });

  it('surfaces the approval-wait state in words', () => {
    expect(actionStatusLabel('pending_approval')).toBe('Waiting for approval');
  });
});

describe('approvalStatusLabel', () => {
  const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'];

  it('maps every approval status to friendly copy', () => {
    for (const s of APPROVAL_STATUSES) {
      expect(looksLikeRawSlug(approvalStatusLabel(s))).toBe(false);
    }
  });
});

describe('triggerKindLabel', () => {
  const TRIGGER_KINDS = ['record_created', 'record_updated', 'record_linked', 'schedule', 'webhook_received'];

  it('maps every trigger kind to a "When …" style phrase', () => {
    for (const k of TRIGGER_KINDS) {
      const label = triggerKindLabel(k);
      expect(looksLikeRawSlug(label)).toBe(false);
    }
    expect(triggerKindLabel('record_created')).toBe('When a record is created');
  });

  it('handles null/unknown trigger', () => {
    expect(triggerKindLabel(null)).toBe('Manual or unknown trigger');
    expect(looksLikeRawSlug(triggerKindLabel('brand_new_trigger'))).toBe(false);
  });
});

describe('actionKindLabel', () => {
  // Every action type from packages/schemas actionSchema, plus future kinds.
  const ACTION_KINDS = [
    'set_values',
    'create_record',
    'add_comment',
    'notify_user',
    'update_linked',
    'send_slack_message',
    'send_webhook',
    'run_agent',
    'send_email',
    'http_request',
    'post_social.linkedin',
    'youtube_upload',
  ];

  it('maps every action kind, no raw slug', () => {
    for (const k of ACTION_KINDS) {
      const label = actionKindLabel(k);
      expect(looksLikeRawSlug(label)).toBe(false);
    }
    expect(actionKindLabel('send_email')).toBe('Email');
    expect(actionKindLabel('send_webhook')).toBe('Webhook');
  });

  it('derives a label for an unmapped social network', () => {
    expect(actionKindLabel('post_social.mastodon')).toBe('Mastodon post');
  });

  it('handles null kind and unmapped kinds', () => {
    expect(actionKindLabel(null)).toBe('Action');
    expect(looksLikeRawSlug(actionKindLabel('brand_new_action'))).toBe(false);
  });
});

describe('runStepSummary', () => {
  it('reads as a plain sentence', () => {
    expect(runStepSummary({ kind: 'send_email', status: 'succeeded' })).toBe('Email — sent');
    expect(runStepSummary({ kind: 'send_webhook', status: 'failed' })).toBe('Webhook — failed');
  });

  it('notes retries when a step failed more than once', () => {
    expect(runStepSummary({ kind: 'send_webhook', status: 'failed', attempts: 3 })).toBe(
      'Webhook — failed after 3 tries',
    );
  });

  it('falls back for a null (pending-approval) kind', () => {
    expect(runStepSummary({ kind: null, status: 'pending_approval', fallbackLabel: 'Send invoice' })).toBe(
      'Send invoice — waiting for approval',
    );
  });
});

describe('runActionSummaryText', () => {
  it('joins step summaries into one plain line', () => {
    expect(
      runActionSummaryText([
        { kind: 'send_email', status: 'succeeded' },
        { kind: 'send_webhook', status: 'failed' },
      ]),
    ).toBe('Email — sent, Webhook — failed');
  });
});

describe('formatDuration', () => {
  it('humanizes millisecond counts', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(340)).toBe('under a second');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(120_000)).toBe('2m');
  });
});

describe('humanizeSlug', () => {
  it('title-cases slugs across separators', () => {
    expect(humanizeSlug('skipped_quota')).toBe('Skipped Quota');
    expect(humanizeSlug('post_social.linkedin')).toBe('Post Social Linkedin');
  });
});
