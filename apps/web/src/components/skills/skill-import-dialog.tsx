'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/api';
import { useSkillImport, type ImportResult } from './use-skills';

type Overrides = Partial<Record<'name' | 'description' | 'when_to_use' | 'instructions', string>>;

const MISSING_LABEL: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  when_to_use: 'When to use',
  instructions: 'Instructions',
};

/**
 * Import a SKILL.md — and SHOW what happened to it.
 *
 * The KEPT / DROPPED report is the requirement, not the parser (ticket #833 / #841): a silent
 * discard means someone imports a skill, watches it land, and never learns part of it did not
 * survive. So nothing is created until the report has been on screen: "Preview" calls the API
 * without `create`, and "Create skill" is only offered once the preview says the file is
 * importable. A field the file does not supply is asked for, never invented.
 */
export function SkillImportDialog({ ws, open, onOpenChange }: { ws: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const importer = useSkillImport(ws);
  const [content, setContent] = useState('');
  const [overrides, setOverrides] = useState<Overrides>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setContent('');
    setOverrides({});
    setResult(null);
    setError(null);
  }

  async function run(create: boolean) {
    setError(null);
    try {
      const r = await importer.mutateAsync({ content, create, overrides });
      setResult(r);
      if (r.created) {
        toast.success(`Imported “${r.created.name}”`);
        onOpenChange(false);
        reset();
        router.push(`/w/${ws}/skills/${r.created.id}`);
      }
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not import this file'));
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setContent(await file.text());
    setResult(null); // a different file invalidates the report on screen
  }

  const report = result?.report;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent title="Import a skill" className="max-h-[85vh] max-w-xl overflow-auto">
        <p className="mb-3 text-label leading-normal text-muted">
          Paste a SKILL.md, or choose the file. You will see what was kept and what was dropped before anything is created.
        </p>
        <input
          type="file"
          accept=".md,text/markdown,text/plain"
          aria-label="Choose a SKILL.md file"
          className="mb-2 block w-full text-label text-muted"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Textarea
          className="min-h-32 font-mono text-label"
          aria-label="SKILL.md contents"
          placeholder={'---\nname: …\ndescription: …\n---\n…'}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setResult(null);
          }}
        />

        {error && (
          <p role="alert" className="mt-2 text-label text-error">
            {error}
          </p>
        )}

        {report && (
          <div className="mt-3 flex flex-col gap-3" data-testid="import-report">
            <ReportSection title={`Kept (${report.kept.length})`} empty="Nothing was kept.">
              {report.kept.map((k, i) => (
                <li key={i}>
                  <b className="text-ink">{k.field}</b> <span className="text-muted">— from {k.from}</span>
                </li>
              ))}
            </ReportSection>
            <ReportSection title={`Dropped (${report.dropped.length})`} empty="Nothing was dropped." emphasis={report.dropped.length > 0}>
              {report.dropped.map((d, i) => (
                <li key={i}>
                  <b className="text-ink">{d.item}</b> <span className="text-muted">— {d.reason}</span>
                </li>
              ))}
            </ReportSection>
            {report.missing.length > 0 && (
              <section>
                <h3 className="mb-1 text-label font-semibold text-ink-secondary">The file does not say — fill these in</h3>
                <div className="flex flex-col gap-1.5">
                  {report.missing.map((f) => (
                    <label key={f} className="flex flex-col gap-0.5 text-label text-muted">
                      {MISSING_LABEL[f] ?? f}
                      {f === 'instructions' ? (
                        <Textarea
                          value={overrides[f as keyof Overrides] ?? ''}
                          onChange={(e) => setOverrides((o) => ({ ...o, [f]: e.target.value }))}
                        />
                      ) : (
                        <Input
                          value={overrides[f as keyof Overrides] ?? ''}
                          onChange={(e) => setOverrides((o) => ({ ...o, [f]: e.target.value }))}
                        />
                      )}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-label text-muted">StoryOS will not invent these. Press Preview again once they are filled.</p>
              </section>
            )}
            {report.problems.length > 0 && (
              <ul className="list-disc pl-4 text-label text-error" role="alert">
                {report.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button variant="secondary" size="sm" disabled={!content.trim() || importer.isPending} onClick={() => void run(false)}>
            {importer.isPending && !result?.importable ? 'Checking…' : 'Preview'}
          </Button>
          <Button size="sm" disabled={!result?.importable || importer.isPending} onClick={() => void run(true)}>
            Create skill
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReportSection({
  title,
  empty,
  emphasis,
  children,
}: {
  title: string;
  empty: string;
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <section className={emphasis ? 'rounded-[var(--radius-control)] border border-warning/40 bg-warning/10 p-2' : undefined}>
      <h3 className="mb-1 text-label font-semibold text-ink-secondary">{title}</h3>
      {items.length === 0 ? <p className="text-label text-muted">{empty}</p> : <ul className="flex list-disc flex-col gap-0.5 pl-4 text-label">{children}</ul>}
    </section>
  );
}
