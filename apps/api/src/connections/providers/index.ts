import { apifyProvider } from './apify';
import { googleProvider } from './google';
import { resendProvider } from './resend';
import { smtpProvider } from './smtp';
import type { ProviderDescriptor } from './types';

export * from './types';
export { apifyProvider } from './apify';
export type { ApifyAuth } from './apify';
export { resendProvider } from './resend';
export type { ResendAuth } from './resend';
export { googleProvider } from './google';
export type { GoogleAuth } from './google';
export { smtpProvider } from './smtp';
export type { SmtpConnectionAuth } from './smtp';

/**
 * The provider registry (MN-252 Step 2). Adding a provider is exactly: a new
 * file next to this one exporting a `ProviderDescriptor`, plus one entry
 * below — never a schema change (`connections.provider` is free text).
 */
export const PROVIDER_REGISTRY: ReadonlyMap<string, ProviderDescriptor> = new Map(
  [apifyProvider, resendProvider, googleProvider, smtpProvider].map((p) => [p.id, p]),
);
