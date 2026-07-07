import { createAuthClient } from 'better-auth/react';
import { API_URL } from './api';

export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/v1/auth`,
});

export const { useSession, signIn, signUp, signOut } = authClient;
