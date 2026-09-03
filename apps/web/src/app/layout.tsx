import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree } from 'next/font/google';
import Script from 'next/script';
import { Providers } from './providers';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-figtree',
});

export const metadata: Metadata = {
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
    <html lang="en" className={figtree.variable} suppressHydrationWarning>
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
