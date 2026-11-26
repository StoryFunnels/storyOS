'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Ticket #1340: the per-request CSP nonce, for the client code that creates `<style>` elements at runtime (the editor stack).
 * `style-src-elem` allows only nonce'd style elements, so each of those must carry the same nonce the proxy put in the policy.
 * The root layout reads it from the `x-nonce` request header that `src/proxy.ts` sets (the one nonce mechanism, the same one
 * Next uses for scripts) and provides it here. `undefined` outside a request (a unit test, or CSP_MODE off): no nonce attribute.
 */
const StyleNonceContext = createContext<string | undefined>(undefined);

export function StyleNonceProvider({ nonce, children }: { nonce: string | undefined; children: ReactNode }) {
  return <StyleNonceContext.Provider value={nonce}>{children}</StyleNonceContext.Provider>;
}

export function useStyleNonce(): string | undefined {
  return useContext(StyleNonceContext);
}

/**
 * The BlockNote editor option that hands the nonce to tiptap (and to BlockNote's placeholder `<style>`): spread it into every
 * `useCreateBlockNote({...})` so no editor surface creates an un-nonced style element.
 */
export function editorNonceOptions(nonce: string | undefined): { _tiptapOptions: { injectNonce: string | undefined } } {
  return { _tiptapOptions: { injectNonce: nonce } };
}
