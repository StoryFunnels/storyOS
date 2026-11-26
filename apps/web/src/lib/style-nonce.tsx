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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- assigned for the bundler, which exposes it to libraries
declare let __webpack_nonce__: string | undefined;

/**
 * Hand the nonce to the libraries that read the bundler's nonce global. Radix's scroll lock (`react-remove-scroll-bar`, behind every
 * dropdown, dialog, select and popover) injects a `<style>` through `get-nonce`, which reads `__webpack_nonce__` and nothing else we
 * can reach; unset, that style has no nonce and `style-src-elem` blocks it on every open (the page then never gets its scrollbar
 * compensation). It must be set before the first Radix surface mounts, so the provider does it during render, client only.
 * The bundler rewrites the bare assignment; `globalThis` is set too for a runtime that reads the global directly.
 */
export function applyBundlerNonce(nonce: string | undefined): void {
  if (!nonce || typeof window === 'undefined') return;
  try {
    __webpack_nonce__ = nonce;
  } catch {
    // Not running under a bundler that provides the variable (a unit test): the globalThis copy below still applies.
  }
  (globalThis as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
}

export function StyleNonceProvider({ nonce, children }: { nonce: string | undefined; children: ReactNode }) {
  applyBundlerNonce(nonce);
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
