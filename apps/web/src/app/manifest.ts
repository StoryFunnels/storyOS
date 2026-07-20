import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'StoryOS — the open-source work OS',
    short_name: 'StoryOS',
    description:
      'Open-source, self-hostable work OS: user-defined relational databases, boards, calendars, automations and formulas.',
    start_url: '/',
    display: 'standalone',
    background_color: '#FAF7F1',
    theme_color: '#FAF7F1',
    icons: [
      // Neither icon has a maskable safe zone yet — declared "any" only, not "maskable",
      // so OS launchers don't crop the rounded-rect artwork against a circular mask.
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
