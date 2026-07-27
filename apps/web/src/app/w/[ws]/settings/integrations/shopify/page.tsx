'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingBag } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL, apiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSpaces } from '@/lib/queries';

interface Connection {
  id: string;
  provider: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

interface CatalogueResult {
  databases: { products: string; variants: string; collections: string };
  sources: Array<{ role: 'products' | 'variants' | 'collections'; attached: boolean; error?: string }>;
  notes: string[];
}

/**
 * #110 — the Shopify product-catalogue guided setup page. Mirrors the YouTube
 * integration page + #215's Connect → Configure → Verify pattern, but the
 * "Configure" step is a single one-click that provisions the whole catalogue
 * (Products/Variants/Collections databases, the three sources, and the
 * product↔variant / product↔collection relations) via the server endpoint.
 */
export default function ShopifyIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const queryClient = useQueryClient();
  const spaces = useSpaces(ws);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [spaceId, setSpaceId] = useState('');
  const [namePrefix, setNamePrefix] = useState('');
  const [created, setCreated] = useState<CatalogueResult | null>(null);

  const connections = useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Connection[] }).data;
    },
  });
  const shopifyConnection = connections.data?.find(
    (connection) => connection.provider === 'shopify' && connection.status === 'active',
  );
  const connected = Boolean(shopifyConnection);

  const createCatalogue = useMutation({
    mutationFn: async () => {
      if (!shopifyConnection) throw new Error('Connect Shopify first');
      if (!spaceId) throw new Error('Choose a space');
      const response = await fetch(`${API_URL}/api/v1/workspaces/${ws}/integrations/shopify/catalogue`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          space_id: spaceId,
          connection_id: shopifyConnection.id,
          ...(namePrefix.trim() ? { name_prefix: namePrefix.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Catalogue creation failed (${response.status})`);
      }
      return (await response.json()) as CatalogueResult;
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['databases', ws] });
      setCreated(result);
      setDialogOpen(false);
      const attached = result.sources.filter((s) => s.attached).length;
      toast.success(
        attached === result.sources.length
          ? 'Product catalogue created — all three sources are attached and will sync'
          : `Product catalogue created — ${attached} of ${result.sources.length} sources attached (add the rest manually)`,
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not create the product catalogue')),
  });

  function openDialog() {
    setSpaceId(spaces.data?.[0]?.id ?? '');
    setNamePrefix('');
    setDialogOpen(true);
  }

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link className="text-[12px] text-muted hover:text-ink" href={`/w/${ws}/settings/integrations`}>
        ← Integrations
      </Link>
      <div className="mt-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-hover">
          <ShoppingBag className="h-6 w-6 text-ink" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">Shopify</h1>
          <p className="text-[13px] text-muted">
            Bring your product catalogue into StoryOS, with navigable relations.
          </p>
        </div>
      </div>

      <IntegrationSetupGuide
        className="mt-6"
        steps={[
          {
            label: 'Connect Shopify',
            description: 'Save your store domain and Admin API access token as a connection.',
            complete: connected,
          },
          {
            label: 'Create the product catalogue',
            description: 'One click builds the Products, Variants and Collections databases and attaches the sources.',
            complete: Boolean(created),
          },
          {
            label: 'Sync and browse',
            description:
              'Open Products and press Sync now. Variants and collections link back to their products automatically.',
            complete: false,
          },
        ]}
      />

      <section className="mt-6 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <h2 className="text-sm font-semibold text-ink">
          {connected ? 'Shopify is connected' : 'Connect your Shopify store'}
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          {connected
            ? 'You can now create the product catalogue below, or add individual Shopify sources from any database.'
            : 'StoryOS uses a custom app Admin API access token (read-only scopes). It never modifies your store.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {!connected && (
            <Link href={`/w/${ws}/settings/connections?add=shopify&name=${encodeURIComponent('Shopify')}`}>
              <Button>Connect Shopify</Button>
            </Link>
          )}
          <Link href={`/w/${ws}/settings/connections`}>
            <Button variant="secondary">Manage connection</Button>
          </Link>
        </div>
      </section>

      {connected && (
        <section className="mt-5 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
          <h2 className="text-sm font-semibold text-ink">Create the product catalogue</h2>
          <p className="mt-1 text-[13px] text-muted">
            Creates three databases — <strong>Products</strong>, <strong>Variants</strong> and{' '}
            <strong>Collections</strong> — attaches the matching Shopify sources with fields pre-mapped,
            and links variants and collections to their products.
          </p>
          <div className="mt-4">
            <Button onClick={openDialog} disabled={createCatalogue.isPending}>
              Create Product Catalogue
            </Button>
          </div>
          {created && (
            <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius-control)] bg-accent-soft p-3">
              <p className="text-[13px] text-ink">
                Your catalogue is ready. Open <strong>Products</strong> and press <strong>Sync now</strong>{' '}
                (or wait for the daily schedule). Variants and collections link back to products as they
                sync.
              </p>
              {created.notes.length > 0 && (
                <ul className="list-disc pl-5 text-[12px] text-muted">
                  {created.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Link href={`/w/${ws}/d/${created.databases.products}`}>
                  <Button size="sm">Open Products</Button>
                </Link>
                <Link href={`/w/${ws}/d/${created.databases.variants}`}>
                  <Button size="sm" variant="secondary">
                    Open Variants
                  </Button>
                </Link>
                <Link href={`/w/${ws}/d/${created.databases.collections}`}>
                  <Button size="sm" variant="secondary">
                    Open Collections
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </section>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent title="Create Shopify product catalogue">
          <p className="mb-4 text-[13px] text-muted">
            Three databases are created in the chosen space, each with its Shopify source attached and
            pre-mapped.
          </p>
          <div className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <Label>Space</Label>
              <select
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-[13px] text-ink"
                value={spaceId}
                onChange={(event) => setSpaceId(event.target.value)}
              >
                <option value="">Choose space</option>
                {(spaces.data ?? []).map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shopify-name-prefix">Name prefix (optional)</Label>
              <Input
                id="shopify-name-prefix"
                value={namePrefix}
                maxLength={60}
                placeholder="e.g. Shopify"
                onChange={(event) => setNamePrefix(event.target.value)}
              />
              <p className="text-[11px] text-faint">
                Prefixes each database name (e.g. &quot;Shopify Products&quot;) so a second store doesn&apos;t
                collide.
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button disabled={!spaceId || createCatalogue.isPending} onClick={() => createCatalogue.mutate()}>
              {createCatalogue.isPending ? 'Creating…' : 'Create catalogue'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
