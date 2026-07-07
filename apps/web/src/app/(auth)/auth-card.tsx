import type { ReactNode } from 'react';

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-[var(--radius-modal)] border border-border-default bg-card p-8">
        <div className="mb-6">
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-[var(--text-on-dark)]">
            S
          </div>
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}
