'use client';

import { MantineProvider } from '@mantine/core';
import type { ReactNode } from 'react';
import { useStyleNonce } from '@/lib/style-nonce';

/**
 * Ticket #1340: the one Mantine provider every BlockNote editor sits in, so the `<style>` Mantine renders (its responsive
 * visibility classes) carries the request's CSP nonce. `style-src-elem` allows only nonce'd style elements.
 *
 * `BlockNoteView` makes its own provider only when none is above it, and that fallback passes exactly these two props
 * (`withCssVariables={false}`, `getRootElement={() => undefined}`) and no nonce. This is that fallback plus `getStyleNonce`,
 * so the editor renders the same; it is deliberately NOT mounted at the app root (that would add Mantine's global CSS
 * variables and color-scheme handling to every page). Wrap each `<BlockNoteView>` in it; do not copy it.
 */
export function EditorMantine({ children, nonce: override }: { children: ReactNode; nonce?: string }) {
  const fromContext = useStyleNonce();
  const nonce = override ?? fromContext;
  return (
    <MantineProvider withCssVariables={false} getRootElement={() => undefined} getStyleNonce={nonce ? () => nonce : undefined}>
      {children}
    </MantineProvider>
  );
}
