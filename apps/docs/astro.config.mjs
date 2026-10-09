// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import { readFileSync } from 'node:fs';

/*
 * Analytics — cookieless, env-gated, and inert until configured.
 *
 * Mirrors the marketing site's src/components/Analytics.astro: PostHog in
 * cookieless (memory persistence) mode, so the docs need NO cookie banner and
 * collect no personal data. Session recording is off.
 *
 * Astro does not expose .env to astro.config at config-evaluation time, and
 * `vite`'s loadEnv is not reachable either (vite is not a direct dependency of
 * this package), so the value is read with the small dependency-free parser
 * below (readEnvFile). With PUBLIC_POSTHOG_KEY unset, `head` stays empty and
 * not a single byte of analytics reaches the page -- which is the default for
 * a fresh clone and for every self-hoster.
 *
 * Unlike the app (apps/web), the docs have no /ingest reverse-proxy rewrite,
 * so events go to the PostHog host directly.
 */
function readEnvFile() {
  // Astro does not expose .env to astro.config at config-evaluation time, and
  // `vite` is not a direct dependency of this package, so parse the file here.
  // Deliberately minimal: KEY=VALUE, '#' comments, optional surrounding quotes.
  try {
    return Object.fromEntries(
      readFileSync(new URL('.env', import.meta.url), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const i = line.indexOf('=');
          if (i === -1) return null;
          const key = line.slice(0, i).trim();
          const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
          return [key, value];
        })
        .filter(Boolean),
    );
  } catch {
    return {}; // no .env -> analytics stays off, which is the intended default
  }
}

const env = { ...readEnvFile(), ...process.env };
const phKey = env.PUBLIC_POSTHOG_KEY;
const phHost = env.PUBLIC_POSTHOG_HOST;

const analyticsHead = phKey
  ? [
      {
        tag: 'script',
        content: `!(function(t,e){var o,n,p,r;e.__SV||((window.posthog=e),(e._i=[]),(e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&((t=t[o[0]]),(e=o[1])),(t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)));});}((p=t.createElement("script")).type="text/javascript"),(p.crossOrigin="anonymous"),(p.async=!0),(p.src=s.api_host+"/static/array.js"),(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?(u=e[a]=[]):(a="posthog"),u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e;},u.people.toString=function(){return u.toString(1)+".people (stub)";},o="init capture register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a]);}),(e.__SV=1));})(document,window.posthog||[]);
posthog.init(${JSON.stringify(phKey)}, { api_host: ${JSON.stringify(phHost || 'https://us.i.posthog.com')}, persistence: 'memory', capture_pageview: true, autocapture: true, disable_session_recording: true });`,
      },
    ]
  : [];

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.storyos.dev',
  integrations: [
    starlight({
      head: analyticsHead,
      title: 'StoryOS Docs',
      description:
        'The open-source, API-first work OS: user-defined relational databases you can run — and let AI agents run — an entire company on.',
      logo: {
        light: './src/assets/logo.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: [
        '@fontsource-variable/figtree/index.css',
        './src/styles/brand.css',
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/StoryFunnels/storyOS',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/StoryFunnels/storyOS/edit/main/apps/docs/',
      },
      plugins: [
        // Renders the committed OpenAPI spec into a reference section under /api.
        starlightOpenAPI([
          {
            base: 'api/reference',
            label: 'API Reference',
            schema: './openapi.json',
            collapsed: false,
          },
        ]),
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'What is StoryOS', slug: 'getting-started/what-is-storyos' },
            { label: 'Quickstart', slug: 'getting-started/quickstart' },
            { label: 'Core concepts', slug: 'getting-started/concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Share a portal with a client', slug: 'guides/client-portals' },
            { label: 'Creating a workspace', slug: 'guides/creating-a-workspace' },
            { label: 'Migrating your data', slug: 'guides/migrate-data' },
            { label: 'Migrate from Linear', slug: 'guides/migrate-from-linear' },
            { label: 'Removing a member, and GDPR', slug: 'guides/removing-a-member' },
            { label: 'Keyboard shortcuts', slug: 'guides/keyboard-shortcuts' },
            { label: 'Webhooks', slug: 'guides/webhooks' },
            { label: 'Sources', slug: 'guides/sources' },
            { label: 'Copying a record into another database', slug: 'guides/copy-record' },
            { label: 'Sync with Google Calendar', slug: 'guides/google-calendar-sync' },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { label: 'Overview', slug: 'self-hosting/overview' },
            { label: 'Configuration', slug: 'self-hosting/configuration' },
            { label: 'Attachments (S3/MinIO)', slug: 'self-hosting/attachments' },
            { label: 'Backup & upgrade', slug: 'self-hosting/backup-upgrade' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Workspaces, spaces & databases', slug: 'concepts/workspaces-spaces-databases' },
            { label: 'Databases & fields', slug: 'concepts/databases-and-fields' },
            { label: 'Relations', slug: 'concepts/relations' },
            { label: 'Lookups & rollups', slug: 'concepts/lookups-and-rollups' },
            { label: 'Formulas', slug: 'concepts/formulas' },
            { label: 'Views', slug: 'concepts/views' },
            { label: 'Automations & buttons', slug: 'concepts/automations' },
            { label: 'Access & roles', slug: 'concepts/access-and-roles' },
            { label: 'Data model reference', slug: 'concepts/data-model' },
            { label: 'Mentions and notifications', slug: 'concepts/mentions-and-notifications' },
            { label: 'Files & attachments', slug: 'concepts/attachments' },
            { label: 'Record history', slug: 'concepts/record-history' },
            { label: 'Personal space', slug: 'concepts/personal-space' },
            { label: 'Dashboards', slug: 'concepts/dashboards' },
            { label: 'Organising the sidebar', slug: 'concepts/organising-the-sidebar' },
            { label: 'Tyron, the in-app assistant', slug: 'concepts/tyron' },
            { label: 'Agent runs', slug: 'concepts/agent-runs' },
            { label: 'Skills', slug: 'concepts/skills' },
            { label: 'Split-screen panels', slug: 'concepts/split-screen' },
            { label: 'Portal recipients', slug: 'concepts/portal-recipients' },
          ],
        },
        {
          label: 'Use with AI (MCP)',
          items: [
            { label: 'Overview', slug: 'mcp/overview' },
            { label: 'Tools', slug: 'mcp/tools' },
            { label: 'Connect (Claude Code & Desktop)', slug: 'mcp/connect' },
            { label: 'Hosted MCP (HTTP + PAT)', slug: 'mcp/hosted' },
            { label: 'OAuth connector', slug: 'mcp/oauth' },
          ],
        },
        {
          label: 'API',
          items: [
            { label: 'Overview', slug: 'api/overview' },
            { label: 'Authentication', slug: 'api/authentication' },
            { label: 'Querying records', slug: 'api/querying' },
            { label: 'Conventions', slug: 'api/conventions' },
            { label: 'Build an MCP server', slug: 'api/build-an-mcp-server' },
            // Auto-generated OpenAPI reference groups:
            ...openAPISidebarGroups,
          ],
        },
      ],
    }),
  ],
});
