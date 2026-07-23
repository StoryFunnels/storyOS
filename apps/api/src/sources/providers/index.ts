import { apifyActorProvider } from './apify';
import { youtubeCommentsProvider, youtubeMetricsProvider, youtubeVideosProvider } from './youtube';
import { metaEngagementProvider } from './meta_engagement';
import { xEngagementProvider } from './x_engagement';
import { linkedinEngagementProvider } from './linkedin_engagement';
import type { SourceProviderDescriptor } from './types';

export * from './types';
export * from './engagement';
export { youtubeVideosProvider, youtubeCommentsProvider, youtubeMetricsProvider } from './youtube';
export { metaEngagementProvider, metaEngagementConfigSchema } from './meta_engagement';
export { xEngagementProvider, xEngagementConfigSchema } from './x_engagement';
export { linkedinEngagementProvider, linkedinEngagementConfigSchema } from './linkedin_engagement';
export { apifyActorProvider, apifyActorConfigSchema } from './apify';
export type { ApifyActorConfig } from './apify';

/**
 * The source provider registry (#239 Step 2). Adding a provider — MN-261's
 * social engagement sources, MN-262's Apify source — is exactly: a new file
 * next to this one exporting a `SourceProviderDescriptor`, plus one entry
 * below. Never a schema change (`sources.providerSource` is free text).
 */
export const SOURCE_PROVIDER_REGISTRY: ReadonlyMap<string, SourceProviderDescriptor> = new Map(
  [
    youtubeVideosProvider,
    youtubeCommentsProvider,
    youtubeMetricsProvider,
    metaEngagementProvider,
    xEngagementProvider,
    linkedinEngagementProvider,
    apifyActorProvider,
  ].map((p) => [p.id, p]),
);
