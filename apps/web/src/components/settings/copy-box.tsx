'use client';

import posthog from 'posthog-js';
import { Clipboard } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export async function copyToClipboard(value: string, event: string, properties?: Record<string, string>) {
  await navigator.clipboard.writeText(value);
  posthog.capture(event, properties);
  toast.success('Copied');
}

/** The connector name or the server address, in a box with its own Copy button (Connect your AI and its Reconnect panel). */
export function CopyBox({ value, label, onCopy }: { value: string; label: string; onCopy: () => void }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-card py-1.5 pl-2.5 pr-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-ink">{value}</code>
      <Button size="sm" variant="secondary" aria-label={`Copy ${label}`} onClick={onCopy}>
        <Clipboard className="mr-1 h-3 w-3" />
        Copy
      </Button>
    </div>
  );
}
