import { createAuthClient } from 'better-auth/react';
import { API_URL } from './api';

// better-auth requires an ABSOLUTE base URL at module init. With same-origin
// builds (API_URL === '', MN-068) resolve it from the browser at runtime; the
// prerender-time placeholder is never fetched — auth only runs client-side.
const origin =
  API_URL || (typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin);

export const authClient = createAuthClient({
  baseURL: `${origin}/api/v1/auth`,
});

export const { useSession, signIn, signUp, signOut } = authClient;
