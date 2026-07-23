import { youtubeCommentsProvider, youtubeMetricsProvider, youtubeVideosProvider } from './youtube';
import type { SourceProviderDescriptor } from './types';

export * from './types';
export { youtubeVideosProvider, youtubeCommentsProvider, youtubeMetricsProvider } from './youtube';

/**
 * The source provider registry (#239 Step 2). Adding a provider — MN-261's
 * social engagement sources, MN-262's Apify source — is exactly: a new file
 * next to this one exporting a `SourceProviderDescriptor`, plus one entry
 * below. Never a schema change (`sources.providerSource` is free text).
 */
export const SOURCE_PROVIDER_REGISTRY: ReadonlyMap<string, SourceProviderDescriptor> = new Map(
  [youtubeVideosProvider, youtubeCommentsProvider, youtubeMetricsProvider].map((p) => [p.id, p]),
);
