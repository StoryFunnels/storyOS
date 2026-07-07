'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { isErrorEnvelope } from '@storyos/sdk';
import { AuthCard } from '../(auth)/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: apiError } = await api.POST('/api/v1/workspaces', { body: { name } });
    setBusy(false);
    if (apiError) {
      setError(isErrorEnvelope(apiError) ? apiError.error.message : 'Could not create workspace');
      return;
    }
    router.replace(`/w/${(data as { id: string }).id}`);
  }

  return (
    <AuthCard title="Create your workspace">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Workspace name</Label>
          <Input
            id="name"
            required
            placeholder="e.g. JCM Agency"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <p className="text-[13px] text-error">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
    </AuthCard>
  );
}
