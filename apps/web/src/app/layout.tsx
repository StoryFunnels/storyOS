import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DM_Sans, Figtree, Inter, JetBrains_Mono, Playfair_Display, Source_Sans_3, Source_Serif_4 } from 'next/font/google';
import Script from 'next/script';
import { Providers } from './providers';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-figtree',
});

/**
 * #720 — the embed font control's other six families (`figtree` above covers
 * the seventh — the app's own default reused, not reloaded). Each is
 * build-time self-hosted the same way Figtree already is; see
 * embed-fonts.ts's own comment for why this file is the only place these
 * loaders are instantiated, and docs/design/form-embed-theming-spec.md §4 for
 * why that self-hosting is what makes this privacy-safe. Three weights
 * (regular/medium/semibold) — a form's own type scale never asks these for
 * bold, and a fourth weight per family is exactly the "a few more won't hurt"
 * bundle creep AC4 warns against.
 */
const embedInter = Inter({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-embed-inter' });
const embedSourceSans3 = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-embed-source-sans-3',
});
const embedDmSans = DM_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-embed-dm-sans' });
const embedSourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-embed-source-serif-4',
});
const embedPlayfairDisplay = Playfair_Display({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-embed-playfair-display',
});
const embedJetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-embed-jetbrains-mono',
});
const embedFontVariables = [
  embedInter.variable,
  embedSourceSans3.variable,
  embedDmSans.variable,
  embedSourceSerif4.variable,
  embedPlayfairDisplay.variable,
  embedJetbrainsMono.variable,
].join(' ');

export const metadata: Metadata = {
  // #566 — unset before this meant Next fell back to 'http://localhost:3000'
  // for resolving og:image/twitter:image on EVERY page, so a shared link's
  // unfurl preview pointed at the reader's own machine. `WEB_URL` is the
  // existing public-origin var (docker-compose.yml), already passed to the
  // mcp service for the same reason — reused here, not a second source of truth.
  metadataBase: new URL(process.env.WEB_URL ?? 'http://localhost:3000'),
  title: { default: 'StoryOS — the open-source work OS', template: '%s · StoryOS' },
  description:
    'Open-source, self-hostable work OS: user-defined relational databases, boards, calendars, automations and formulas. Free forever.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'StoryOS — the open-source work OS',
    description: 'Databases · relations · boards · automations — self-hosted, free forever.',
    images: [{ url: '/og.png', width: 1200, height: 630 }],
    siteName: 'StoryOS',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StoryOS — the open-source work OS',
    description: 'Databases · relations · boards · automations — self-hosted, free forever.',
    images: ['/og.png'],
  },
};

export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#FAF7F1' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${figtree.variable} ${embedFontVariables}`} suppressHydrationWarning>
      <head>
        {/* Resolve + apply the saved theme before paint so there's no light flash
            (#30). next/script's beforeInteractive strategy, not a raw <script> tag —
            #486: React warns "Encountered a script tag while rendering React
            component" for the latter, because a plain <script> in the declarative
            tree is not how React expects a script to get onto the page. Script is
            built for exactly this "must run before hydration, in <head>" case; it
            still ends up as inline JS in <head> before paint, so the no-flash
            behaviour is unchanged. */}
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
