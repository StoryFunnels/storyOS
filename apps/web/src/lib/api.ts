import { createStoryOSClient } from '@storyos/sdk';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * The ONLY way the web app talks to the backend (CONTRIBUTING.md).
 * Cookie-authenticated: the SDK sends credentials, better-auth sets the cookie.
 */
export const api = createStoryOSClient({ baseUrl: API_URL });
