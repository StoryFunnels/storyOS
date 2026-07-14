// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.storyos.dev',
  integrations: [
    starlight({
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
            { label: 'Databases & fields', slug: 'concepts/databases-and-fields' },
            { label: 'Relations', slug: 'concepts/relations' },
            { label: 'Lookups & rollups', slug: 'concepts/lookups-and-rollups' },
            { label: 'Formulas', slug: 'concepts/formulas' },
            { label: 'Views', slug: 'concepts/views' },
            { label: 'Automations & buttons', slug: 'concepts/automations' },
            { label: 'Access & roles', slug: 'concepts/access-and-roles' },
            { label: 'Data model reference', slug: 'concepts/data-model' },
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
