'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDot, ExternalLink, GitPullRequest, GitPullRequestDraft } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import { usePreferences } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Bucket = 'needs_review' | 'authored' | 'participating';
const TABS: { id: Bucket; label: string }[] = [
  { id: 'needs_review', label: 'Needs my review' },
  { id: 'authored', label: 'Authored by me' },
  { id: 'participating', label: 'Participating' },
];

interface ReviewItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  author_login: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  updated_at: string;
}

/** Reviews sidebar (#43 AC 1): PRs across the watched repos that need my
 * review, that I authored, or that I'm participating in — GitHub's own
 * three-way split, read via the search API with the reviewer's own login. */
export default function ReviewsPage() {
  const { ws } = useParams<{ ws: string }>();
  const [bucket, setBucket] = useState<Bucket>('needs_review');
  const prefs = usePreferences();
  const login = prefs.data?.github.login ?? null;

  const reviews = useQuery({
    queryKey: ['reviews', ws, bucket, login],
    enabled: Boolean(login),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations/github/reviews', {
        params: { path: { ws }, query: { bucket } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: ReviewItem[] }).data;
    },
  });

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8">
      <h1 className="mb-1 text-xl font-semibold text-ink">Reviews</h1>
      <p className="mb-5 text-sm text-muted">
        Pull requests from your watched GitHub repositories — review the diff, comment, and approve without
        leaving StoryOS.
      </p>

      {!login ? (
        <GithubLoginPrompt ws={ws} />
      ) : (
        <>
          <div className="mb-4 flex gap-1 border-b border-border-default">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setBucket(t.id)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                  bucket === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {reviews.isLoading && <p className="text-sm text-muted">Loading…</p>}
          {reviews.isError && (
            <p className="rounded-[var(--radius-card)] border border-border-default bg-card p-4 text-[13px] text-error">
              {apiErrorMessage(reviews.error, 'Could not load reviews')}
            </p>
          )}
          {reviews.data && reviews.data.length === 0 && (
            <p className="rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-[13px] text-muted">
              Nothing here right now.
            </p>
          )}

          {reviews.data && reviews.data.length > 0 && (
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
              {reviews.data.map((pr) => {
                const [owner, repo] = pr.repo.split('/');
                return (
                  <Link
                    key={`${pr.repo}#${pr.number}`}
                    href={`/w/${ws}/reviews/${owner}/${repo}/${pr.number}`}
                    className="flex items-center gap-3 border-b border-border-default px-4 py-3 last:border-b-0 hover:bg-hover"
                  >
                    {pr.draft ? (
                      <GitPullRequestDraft className="h-4 w-4 shrink-0 text-muted" />
                    ) : (
                      <GitPullRequest className="h-4 w-4 shrink-0 text-success" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{pr.title}</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-faint">
                        {pr.repo}#{pr.number}
                        {pr.author_login && <> · {pr.author_login}</>}
                      </span>
                    </span>
                    <CircleDot className={cn('h-3 w-3 shrink-0', pr.state === 'open' ? 'text-success' : 'text-muted')} />
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** No per-user GitHub OAuth identity exists (App connect is workspace-level) —
 * the reviewer types their own login once, stored in their preferences. */
function GithubLoginPrompt({ ws }: { ws: string }) {
  const [value, setValue] = useState('');
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await api.PATCH('/api/v1/users/me/preferences', {
        body: { github: { login: value.trim() } } as never,
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['preferences'] }),
  });

  return (
    <div className="max-w-md rounded-[var(--radius-card)] border border-border-default bg-card p-5">
      <h2 className="mb-1 text-[14px] font-semibold text-ink">What&apos;s your GitHub username?</h2>
      <p className="mb-3 text-[13px] text-muted">
        StoryOS connects to GitHub as an App installation, not as you personally — your username is how we tell
        &quot;needs my review&quot; apart from &quot;authored by me&quot;.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) save.mutate();
        }}
      >
        <Input
          autoFocus
          placeholder="e.g. octocat"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" disabled={!value.trim() || save.isPending}>
          Save
        </Button>
      </form>
      <Link
        href={`/w/${ws}/settings/integrations/github`}
        className="mt-3 inline-flex items-center gap-1 text-[12px] text-info hover:underline"
      >
        GitHub not connected yet? <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  );
}
