'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { AuthCard } from '../../auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function ConfirmForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = params.get('token');
    if (!token) {
      setError('Missing reset token');
      return;
    }
    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) setError(result.error.message ?? 'Reset failed');
    else router.replace('/login');
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && <p className="text-[13px] text-error">{error}</p>}
      <Button type="submit">Set new password</Button>
    </form>
  );
}

export default function ResetConfirmPage() {
  return (
    <AuthCard title="Choose a new password">
      <Suspense>
        <ConfirmForm />
      </Suspense>
    </AuthCard>
  );
}
