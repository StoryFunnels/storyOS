import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { connections } from '../db/schema';
import { open } from '../common/secretbox';
import type { RawBodyRequest } from '../app.setup';
import { SourcesService } from '../sources/sources.service';
import { SHOPIFY_SOURCE_BY_ROLE } from './shopify-catalogue';
import type { ShopifyAuth } from '../connections/providers/shopify';
import { mapCollectionWebhook, mapProductWebhook, routeTopic, verifyShopifyHmac } from './shopify-webhook';

/**
 * Path PREFIX (not an exact path — `:connectionId` varies), so app.setup.ts's
 * raw-body allowlist can retain the wire bytes for every delivery here — same
 * reason RESEND_WEBHOOK_PATH_PREFIX / HOOKS_PATH_PREFIX are prefixes, not
 * exact-match GITHUB_WEBHOOK_PATH.
 */
export const SHOPIFY_WEBHOOK_PATH_PREFIX = '/api/v1/providers/shopify/webhook/';

/**
 * The webhook signing secret is read from the environment, never git (#24):
 *  - `SHOPIFY_WEBHOOK_SECRET` — the operator sets it to the Shopify app's API
 *    secret key (the value Shopify signs every webhook with).
 *  - A per-connection `webhook_secret` on the sealed `ShopifyAuth` takes
 *    precedence when present, for the per-store custom-app model where each
 *    store's app has its own secret. (No connect-flow UI adds it today; it's an
 *    operator/forward-compat override — the env var is the documented path.)
 */
function signingSecretFor(auth: Partial<ShopifyAuth> & { webhook_secret?: string }): string | null {
  const perConnection = auth.webhook_secret?.trim();
  if (perConnection) return perConnection;
  const env = process.env.SHOPIFY_WEBHOOK_SECRET?.trim();
  return env || null;
}

/**
 * #24 — Shopify real-time webhook receiver (products/collections; variants
 * arrive nested in the product payload).
 *
 * **Unauthenticated by necessity** — Shopify holds no session — so the
 * `X-Shopify-Hmac-Sha256` HMAC over the raw body is the only thing standing
 * between a stranger and the catalogue. It is verified before the payload is
 * read into meaning at all. The `:connectionId` in the URL names the tenant
 * (which workspace + which store's catalogue), the same shape MN-256's Resend
 * webhook uses; a delivery whose `X-Shopify-Shop-Domain` doesn't match that
 * connection's sealed shop domain is rejected too (defense in depth).
 *
 * Every write goes through `SourcesService.ingestExternalItems`, the SAME
 * idempotent GID-keyed upsert engine the scheduled sync uses — so a push and a
 * scheduled tick for the same object converge on one record, and the relation
 * materializer (shopify-catalogue.subscriber.ts) fires off the resulting
 * `record_created`/`record_updated` exactly as it does for a scheduled sync.
 *
 * Every failure mode is an indistinguishable 401 (unknown/non-shopify
 * connection, no configured secret, bad signature, shop-domain mismatch) — the
 * "leak nothing" posture the other inbound receivers document. A well-signed
 * delivery that is simply not actionable (unhandled topic, no matching source,
 * unparseable-but-signed body, a delete) is a 200 ack: a 4xx would teach
 * Shopify to disable the hook.
 */
@ApiTags('integrations')
@Controller('providers/shopify')
export class ShopifyWebhookController {
  private readonly logger = new Logger(ShopifyWebhookController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sources: SourcesService,
  ) {}

  @Post('webhook/:connectionId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Shopify product/collection webhook for one connection — HMAC-verified, unauthenticated by design',
  })
  async receive(
    @Param('connectionId') connectionId: string,
    @Req() req: RawBodyRequest,
    @Headers('x-shopify-hmac-sha256') hmacHeader?: string,
    @Headers('x-shopify-topic') topic?: string,
    @Headers('x-shopify-shop-domain') shopDomainHeader?: string,
  ): Promise<{ received: true; handled?: string }> {
    const row = await this.db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
    if (!row || row.provider !== 'shopify' || !req.rawBody || !hmacHeader) {
      throw new UnauthorizedException();
    }

    let auth: Partial<ShopifyAuth> & { webhook_secret?: string };
    try {
      auth = JSON.parse(open(row.authSealed)) as Partial<ShopifyAuth> & { webhook_secret?: string };
    } catch {
      throw new UnauthorizedException();
    }

    const secret = signingSecretFor(auth);
    if (!secret || !verifyShopifyHmac(req.rawBody, secret, hmacHeader)) {
      throw new UnauthorizedException();
    }

    // Defense in depth: the signed body proves the sender knows the secret; the
    // shop-domain header must also name THIS connection's store (Shopify always
    // sends it). A mismatch is as suspect as a bad signature.
    const shopDomain = (auth.shop_domain ?? '').toLowerCase();
    if (shopDomainHeader && shopDomain && shopDomainHeader.trim().toLowerCase() !== shopDomain) {
      throw new UnauthorizedException();
    }

    const route = routeTopic(topic);
    if (!route) return { received: true }; // signed but not a topic we handle — ack

    // A delete converges with the scheduled sync's semantics, which never
    // remove a record when Shopify stops returning an object ("credential/
    // source gone, history stays", shopify.ts). So a delete is acknowledged
    // and left as a no-op on the records rather than forking a delete path
    // that would fight the scheduled sync. (Hard-delete-on-webhook could be a
    // future opt-in.)
    if (route.action === 'delete') {
      return { received: true, handled: `${route.role}/delete:noop` };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { received: true }; // signed but unparseable — ack, nothing actionable
    }

    try {
      if (route.role === 'products') {
        const { product, variants } = mapProductWebhook(shopDomain, payload);
        if (product) {
          await this.sources.ingestExternalItems(row.workspaceId, connectionId, SHOPIFY_SOURCE_BY_ROLE.products, [product]);
        }
        if (variants.length) {
          await this.sources.ingestExternalItems(row.workspaceId, connectionId, SHOPIFY_SOURCE_BY_ROLE.variants, variants);
        }
      } else {
        const collection = mapCollectionWebhook(shopDomain, payload);
        if (collection) {
          await this.sources.ingestExternalItems(
            row.workspaceId,
            connectionId,
            SHOPIFY_SOURCE_BY_ROLE.collections,
            [collection],
          );
        }
      }
    } catch (error) {
      // A well-signed delivery we failed to persist is still acked (200) so
      // Shopify doesn't disable the hook; the next scheduled sync reconciles.
      this.logger.warn(
        `shopify webhook ${topic ?? 'unknown'} ingest failed for connection ${connectionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { received: true, handled: `${route.role}/${route.action}` };
  }
}
