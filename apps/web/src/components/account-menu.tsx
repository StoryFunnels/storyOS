'use client';

import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { API_URL } from '@/lib/api';
import { authClient, useSession } from '@/lib/auth-client';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Downscale to 256px cover-crop PNG before upload (MN-045). */
async function resizeTo256(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    256,
    256,
  );
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

export function AccountMenu() {
  const router = useRouter();
  const { ws } = useParams<{ ws: string }>();
  const { data: session } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  // Cache-bust locally after an upload without waiting for a session refetch.
  const [imageOverride, setImageOverride] = useState<string | null | undefined>(undefined);

  if (!session) return null;
  const image = imageOverride !== undefined ? imageOverride : session.user.image;
  const imageUrl = image ? (image.startsWith('/') ? `${API_URL}${image}` : image) : null;

  async function onFile(file: File) {
    try {
      const blob = await resizeTo256(file);
      const form = new FormData();
      form.append('file', blob, 'avatar.png');
      const res = await fetch(`${API_URL}/api/v1/users/me/avatar`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) throw new Error();
      const { image: newImage } = (await res.json()) as { image: string };
      setImageOverride(newImage);
      toast.success('Photo updated');
    } catch {
      toast.error('Could not upload the photo');
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-hover">
          <Avatar userId={session.user.id} name={session.user.name} image={imageUrl} size={24} />
          <span className="text-sm text-muted">{session.user.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="flex items-center gap-3 border-b border-border-default px-2 py-2.5">
          <Avatar userId={session.user.id} name={session.user.name} image={imageUrl} size={32} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-ink">{session.user.name}</p>
            <p className="truncate text-[12px] text-muted">{session.user.email}</p>
          </div>
        </div>
        <DropdownMenuItem onSelect={() => router.push(`/w/${ws}/settings/account`)}>
          Account
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push(`/w/${ws}/settings/preferences`)}>
          Preferences
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
          {imageUrl ? 'Change photo' : 'Set photo'}
        </DropdownMenuItem>
        {imageUrl && (
          <DropdownMenuItem
            onSelect={async () => {
              await fetch(`${API_URL}/api/v1/users/me/avatar`, {
                method: 'DELETE',
                credentials: 'include',
              });
              setImageOverride(null);
            }}
          >
            Remove photo
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={async () => {
            await authClient.signOut();
            router.replace('/login');
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
          e.target.value = '';
        }}
      />
    </DropdownMenu>
  );
}
