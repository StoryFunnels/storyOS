import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SERVER_API_URL } from '@/lib/api';

/**
 * Ticket #866 — the public skill page: what the link a person shares actually opens.
 *
 * A SKILL IS INERT TEXT. It runs in the reader's OWN AI, against the reader's own workspace and
 * credentials, so publishing one grants a reader access to nothing — which is why a token-addressed
 * unauthenticated page is safe to build, and why there is no data to redact here (do not copy the
 * public-VIEW allowlist machinery). Mirrors `app/v/[token]` (server component, a real 404 for a bad
 * token) rather than the client-only `app/f/[token]`, for the same #566 reason: the server must
 * know the token before it answers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE IS NO RUN BUTTON HERE, AND THAT IS THE POSITION, NOT A GAP (#833 AC6, #866 AC3). Do not add
 * one. StoryOS executes nothing for skills; the model that follows this text is the reader's own,
 * run from their AI client. A public page is exactly where someone will later feel the absence of a
 * "Try it" — and a button that resolves instructions and hands back text does nothing useful while
 * starting the move to putting OUR AI inside OUR product. `skills-surface.unit.test.ts` fails if
 * this directory renders a Run/Execute/Try-it control or calls the run endpoint.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NOT INDEXABLE and not linked from anywhere (AC5): reachable by token only. No index, no search.
 */
interface PublicSkill {
  name: string;
  description: string;
  when_to_use: string;
  instructions: string;
  examples: Array<{ input: string; output: string }>;
  version: string;
  updated_at: string;
}

async function getSkill(token: string): Promise<PublicSkill | null> {
  const res = await fetch(`${SERVER_API_URL}/api/v1/public/skills/${encodeURIComponent(token)}`, { cache: 'no-store' });
  // Unknown, malformed and revoked tokens are one answer (the API's uniform 404, plus its own
  // rejection of a malformed one). Anything else is OUR failure and must not read as "not found".
  if (res.status === 404 || res.status === 400 || res.status === 422) return null;
  if (!res.ok) throw new Error(`public skill read failed: HTTP ${res.status}`);
  return (await res.json()) as PublicSkill;
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const skill = await getSkill(token);
  // Same robots rule whether or not the token resolves: nothing about this page is for a crawler.
  const robots = { index: false, follow: false, nocache: true } as const;
  if (!skill) return { title: 'Not available', robots };
  return {
    title: skill.name,
    description: skill.description,
    robots,
    // Restated rather than inherited: openGraph/twitter REPLACE the root layout's object (#566).
    openGraph: { title: skill.name, description: skill.description, type: 'website', images: [{ url: '/og.png', width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title: skill.name, description: skill.description, images: ['/og.png'] },
  };
}

export default async function PublicSkillPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const skill = await getSkill(token);
  if (!skill) notFound();
  const updated = new Date(skill.updated_at).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <main className="min-h-screen bg-app px-4 py-8 sm:py-12">
      <article className="mx-auto flex max-w-2xl flex-col gap-6">
        <header>
          <p className="text-label font-medium uppercase tracking-wider text-muted">A skill, shared with you</p>
          <h1 className="mt-1 break-words text-title font-bold tracking-tight text-ink sm:text-xl">{skill.name}</h1>
          <p className="mt-1 text-meta text-muted">
            <span className="font-mono">v{skill.version}</span> · updated {updated}
          </p>
          <p className="mt-3 break-words text-prose leading-normal text-ink-secondary">{skill.description}</p>
        </header>

        <section aria-labelledby="when" className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
          <h2 id="when" className="text-body font-bold text-ink">
            When to use it
          </h2>
          <p className="mt-1 break-words text-body leading-normal text-ink-secondary">{skill.when_to_use}</p>
          <p className="mt-2 text-label text-muted">This is the sentence an AI reads to decide whether to use the skill.</p>
        </section>

        <section aria-labelledby="instructions">
          <h2 id="instructions" className="text-body font-bold text-ink">
            Instructions
          </h2>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--radius-card)] border border-border-default bg-card p-4 font-mono text-label leading-relaxed text-ink">
            {skill.instructions}
          </pre>
        </section>

        {skill.examples.length > 0 && (
          <section aria-labelledby="examples" className="flex flex-col gap-3">
            <h2 id="examples" className="text-body font-bold text-ink">
              Examples
            </h2>
            {skill.examples.map((example, i) => (
              <div key={i} className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
                <p className="text-label font-semibold text-muted">Input</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-body text-ink">{example.input}</p>
                <p className="mt-3 text-label font-semibold text-muted">Output</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-body text-ink">{example.output}</p>
              </div>
            ))}
          </section>
        )}

        <footer className="border-t border-border-default pt-4 text-label leading-normal text-muted">
          A skill is text. It does nothing on this page: it is followed by whichever AI you give it to, using your own access.
        </footer>
      </article>
    </main>
  );
}
