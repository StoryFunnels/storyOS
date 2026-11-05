/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Ticket #1046: nothing renders through next/image, so the /_next/image optimizer is switched off rather than left serving.
  images: { unoptimized: true },
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/array/:path*',
        destination: 'https://us-assets.i.posthog.com/array/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
    ];
  },
  async redirects() {
    return [
      // Ticket #1185 — Connect your AI moved out of Integrations in ticket #875, and `integrations/mcp/page.tsx` redirects the old
      // link. But every page under /settings/integrations sits behind the admins-only refusal (#1092), so a MEMBER following an
      // old link got "Integrations is for workspace admins" instead of Connect your AI. A config redirect runs before any layout.
      { source: '/w/:ws/settings/integrations/mcp', destination: '/w/:ws/settings/connect-ai', permanent: false },
      // Ticket #1187 — Governance became Agent rules (new route). Same reason as above: the config redirect runs before the layout.
      { source: '/w/:ws/settings/governance', destination: '/w/:ws/settings/agent-rules', permanent: false },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
