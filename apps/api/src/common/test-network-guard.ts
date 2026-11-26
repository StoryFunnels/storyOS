import { env } from '../config/env';

/**
 * Ticket #42 — a social network's HTTP client must be impossible to call for real from a test. The publish executor and the
 * account picker each keep a swappable `fetcher`; its DEFAULT used to be the real `fetch`, so a test (or a reviewer's probe) that
 * forgot to swap it sent a real request to a real network with whatever token the fixture held. Under NODE_ENV=test the default
 * now refuses, with a message that says how to fix the test; anywhere else it is the real `fetch`. A test supplies its own
 * fetcher by assigning the property, exactly as before.
 */
export class RealNetworkRefused extends Error {
  constructor(url: string) {
    let host = 'an unknown host';
    try {
      host = new URL(url).host;
    } catch {
      /* keep the generic host */
    }
    super(`A real network call to ${host} was refused: this is a test and no fetcher was supplied. Assign the service's \`fetcher\` before calling it.`);
    this.name = 'RealNetworkRefused';
  }
}

/** The `fetch` a service uses unless a test replaced it. */
export function failClosedFetch(): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (env().NODE_ENV === 'test') {
      return Promise.reject(new RealNetworkRefused(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url));
    }
    return fetch(input, init);
  }) as typeof fetch;
}
