import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-figtree',
});

export const metadata: Metadata = {
  title: 'StoryOS',
  description: 'Open-source relational databases that run your company.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
