import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand/brand-mark';
import { Button } from '@/components/ui/button';
import { GoogleIcon } from '@/components/ui/google-icon';

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
          <BrandMark className="mb-3 h-8 w-8" />
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * Ticket #1302, Otto's ruling: on every auth surface (sign in, sign up, the Join screen's inline account creation) "Continue with
 * Google" comes FIRST, then an "or" divider, then the email form. ONE place draws that order so the three cannot drift. Where Google is
 * not configured the caller passes `onGoogle={null}`: no button, no divider, no dangling "or". The buttons here are the 44px `auth` size.
 */
export function AuthMethods({
  onGoogle,
  children,
}: {
  onGoogle: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {onGoogle && (
        <>
          <Button
            type="button"
            variant="secondary"
            size="auth"
            onClick={onGoogle}
            data-testid="auth-google"
          >
            <GoogleIcon className="h-[18px] w-[18px]" />
            Continue with Google
          </Button>
          <div
            className="flex items-center gap-3 text-label text-muted"
            role="separator"
            data-testid="auth-or"
          >
            <span className="h-px flex-1 bg-border-default" aria-hidden="true" />
            or
            <span className="h-px flex-1 bg-border-default" aria-hidden="true" />
          </div>
        </>
      )}
      {children}
    </div>
  );
}
