'use client';

import Link from 'next/link';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { AuthCard } from '../auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function ResetPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await authClient.requestPasswordReset({ email, redirectTo: '/reset/confirm' });
    setSent(true);
  }

  return (
    <AuthCard title="Reset your password">
      {sent ? (
        <p className="text-sm text-ink-secondary">
          If that address has an account, a reset link is on its way. Check your inbox.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button type="submit">Send reset link</Button>
        </form>
      )}
      <p className="mt-4 text-[13px] text-muted">
        <Link className="text-ink underline" href="/login">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
