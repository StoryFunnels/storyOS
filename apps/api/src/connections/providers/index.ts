import { apifyProvider } from './apify';
import { googleProvider } from './google';
import { googleCalendarProvider } from './google-calendar';
import { httpProvider } from './http';
import { resendProvider } from './resend';
import { shopifyProvider } from './shopify';
import { smtpProvider } from './smtp';
import type { ProviderDescriptor } from './types';

export * from './types';
export { availabilityFor } from './availability';
export type { AvailabilityContext } from './availability';
export { apifyProvider } from './apify';
export type { ApifyAuth } from './apify';
export { resendProvider } from './resend';
export type { ResendAuth } from './resend';
export { googleProvider } from './google';
export type { GoogleAuth } from './google';
export { googleCalendarProvider } from './google-calendar';
export { smtpProvider } from './smtp';
export type { SmtpConnectionAuth } from './smtp';
export { httpProvider } from './http';
export type { HttpConnectionAuth } from './http';
export { shopifyProvider, normalizeShopDomain, shopifyGraphql, shopifyGraphqlUrl, shopifyAuthHeaders, SHOPIFY_API_VERSION } from './shopify';
export type { ShopifyAuth } from './shopify';

/**
 * The provider registry (MN-252 Step 2). Adding a provider is exactly: a new
 * file next to this one exporting a `ProviderDescriptor`, plus one entry
 * below — never a schema change (`connections.provider` is free text).
 */
export const PROVIDER_REGISTRY: ReadonlyMap<string, ProviderDescriptor> = new Map(
  [
    apifyProvider,
    resendProvider,
    googleProvider,
    googleCalendarProvider,
    smtpProvider,
    httpProvider,
    shopifyProvider,
  ].map((p) => [p.id, p]),
);
