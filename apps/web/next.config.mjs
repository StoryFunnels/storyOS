/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
