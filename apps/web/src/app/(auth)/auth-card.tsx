import type { ReactNode } from 'react';

export function AuthCard({
  title,
  children,
  /**
   * #351 — opt-in wider card. Login and signup are single-column forms and stay
   * at max-w-sm; the create-workspace screen is a PICKER, and at 384px a
   * two-column pack grid gives ~155px per card, which clipped every title and
   * preview label. Opt-in so the auth screens are untouched.
   */
  wide = false,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div
        className={`w-full rounded-[var(--radius-modal)] border border-border-default bg-card p-8 ${
          wide ? 'max-w-2xl' : 'max-w-sm'
        }`}
      >
        <div className="mb-6">
          <img src="/brand/mark.svg" alt="StoryOS" className="mb-3 h-8 w-8" />
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}
