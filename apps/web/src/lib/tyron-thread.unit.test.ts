import { beforeEach, describe, expect, it } from 'vitest';
import { keyFor, readRememberedThread, rememberThread } from './tyron-thread';

/**
 * #403 — reopening Tyron must return to the same conversation.
 *
 * The data was never lost: #359 shipped `tyron_threads` + `tyron_messages` and
 * they persist correctly. The panel kept the thread id in component state, so
 * closing it unmounted the component and reopening started from nothing.
 *
 * The rule worth testing is the SCOPING. A single key for every workspace would
 * resume a conversation from somewhere else after a switch — and because a
 * thread is workspace-scoped on the server, that id 404s and the panel looks
 * broken for a reason the user cannot see.
 *
 * This suite runs in `node`, so it stubs `window.localStorage` rather than
 * pulling in jsdom for five assertions about a string key.
 */
function stubStorage() {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return store;
}

describe('#403 remembered thread', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = stubStorage();
  });

  it('remembers a thread and reads it back', () => {
    rememberThread('ws-1', 'thread-a');
    expect(readRememberedThread('ws-1')).toBe('thread-a');
  });

  it('is scoped PER WORKSPACE', () => {
    rememberThread('ws-1', 'thread-a');
    rememberThread('ws-2', 'thread-b');
    expect(readRememberedThread('ws-1')).toBe('thread-a');
    expect(readRememberedThread('ws-2')).toBe('thread-b');
    // A workspace with no history starts fresh rather than resuming someone
    // else's conversation.
    expect(readRememberedThread('ws-3')).toBeNull();
  });

  it('FORGETS rather than storing the string "null"', () => {
    // "Start a new conversation" clears it. Storing "null" would read back as a
    // thread id and 404 forever — the exact stale-id trap this ticket names.
    rememberThread('ws-1', 'thread-a');
    rememberThread('ws-1', null);
    expect(readRememberedThread('ws-1')).toBeNull();
    expect(store.has(keyFor('ws-1'))).toBe(false);
  });

  it('returns null for a workspace never used', () => {
    expect(readRememberedThread('never-seen')).toBeNull();
  });

  it('overwrites rather than accumulating', () => {
    rememberThread('ws-1', 'thread-a');
    rememberThread('ws-1', 'thread-b');
    expect(readRememberedThread('ws-1')).toBe('thread-b');
    expect(store.size).toBe(1);
  });

  it('namespaces the key so it cannot collide with the panel state', () => {
    // `storyos:tyron-panel` and `storyos:tyron-ratio` already exist. A key that
    // overlapped one of them would silently break the panel's own layout.
    expect(keyFor('ws-1')).toBe('storyos:tyron-thread:ws-1');
    expect(keyFor('ws-1')).not.toBe('storyos:tyron-panel');
  });
});
