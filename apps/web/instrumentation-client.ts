import posthog from 'posthog-js';

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (!token || !host) {
  if (process.env.NODE_ENV === 'development') {
    const missing = [!token && 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', !host && 'NEXT_PUBLIC_POSTHOG_HOST']
      .filter(Boolean)
      .join(', ');
    /**
     * Warn loudly, but NEVER throw.
     *
     * This file runs as Next's client instrumentation, i.e. during client
     * bootstrap and before React hydrates. Throwing here doesn't just skip
     * analytics — it breaks hydration outright, so no effect ever runs. The
     * visible symptom is that every /w/* route sits on the workspace layout's
     * "Loading…" branch forever (useSession() never fires, isPending stays
     * true), which reads as a broken app, not as a missing env var.
     *
     * Since these vars aren't in .env.example, that was the default state of a
     * fresh clone: `pnpm dev` produced a dead app whose only clue was a console
     * error about analytics. The original intent — make un-configured analytics
     * impossible to ignore in development — is fully preserved by console.error.
     */
    console.error(
      `[posthog] ${missing} is missing or un-configured, so analytics events are being silently dropped. This message stops appearing once ${missing} is set. Analytics are disabled; the rest of the app is unaffected.`,
    );
  }
} else {
  posthog.init(token, {
    api_host: '/ingest',
    ui_host: 'https://us.posthog.com',
    defaults: '2026-01-30',
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development',
  });
}
