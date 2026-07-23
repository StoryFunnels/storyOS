import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';
import type { GoogleAuth } from './google';

const CALENDAR_LIST_URL =
  'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1';

/**
 * #20 — a dedicated Calendar credential. It intentionally does not widen the
 * existing `google` provider used by YouTube: reconnecting Calendar must not
 * silently change the permissions of an unrelated Google connection.
 */
export const googleCalendarProvider: ProviderDescriptor = {
  id: 'google-calendar',
  label: 'Google Calendar',
  authKind: 'oauth2',
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar'],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    extraAuthParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  },
  async healthCheck(
    auth: unknown,
    fetcher: ConnectionFetcher = defaultConnectionFetcher,
  ): Promise<void> {
    const { access_token } = (auth ?? {}) as Partial<GoogleAuth>;
    if (!access_token) {
      throw new UnprocessableEntityException(
        'Google Calendar connection is missing an access token',
      );
    }
    const response = await fetcher(CALENDAR_LIST_URL, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new UnprocessableEntityException(
        `Google Calendar token check failed (HTTP ${response.status})`,
      );
    }
  },
};
