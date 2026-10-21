import { describe, expect, it } from 'vitest';
import { DISMISS_GRACE_MS, createBackLayers } from './back-layers';
import type { Traversal } from './nav-trail';

/** A fake world: records every history operation, runs scheduled work on demand. */
function world(opts: { onGuard?: boolean } = {}) {
  const log: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let onGuard = opts.onGuard ?? false;
  const layers = createBackLayers({
    onGuard: () => onGuard,
    pushGuard: () => {
      log.push('pushGuard');
      onGuard = true;
    },
    step: (d) => log.push(`step ${d}`),
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  return {
    layers,
    log,
    timers,
    setOnGuard: (v: boolean) => (onGuard = v),
    flush: () => timers.splice(0).forEach((t) => t.fn()),
  };
}
const back = (over: Partial<Traversal> = {}): Traversal => ({ dir: 'back', leftGuard: true, onGuard: false, ...over });

describe('createBackLayers — Back closes the topmost overlay first (#962)', () => {
  it('the first layer pushes ONE guard; later layers and a reused guard push none', () => {
    const w = world();
    w.layers.register(() => {});
    w.layers.register(() => {});
    expect(w.log).toEqual(['pushGuard']);
    const reused = world({ onGuard: true });
    reused.layers.register(() => {});
    expect(reused.log).toEqual([]);
  });

  it('Back from the guard dismisses the TOP layer and stays on the page', () => {
    const w = world();
    const closed: string[] = [];
    let unregisterTop = () => {};
    w.layers.register(() => void closed.push('lower'));
    unregisterTop = w.layers.register(() => {
      closed.push('top');
      unregisterTop();
    });
    w.setOnGuard(false); // Back moved off the guard
    w.layers.onPopState(back());
    expect(closed).toEqual(['top']);
    w.flush();
    // One layer remains: the guard goes back up so the next Back closes it.
    expect(w.log).toEqual(['pushGuard', 'pushGuard']);
  });

  it('closing the last layer leaves no guard behind to push', () => {
    const w = world();
    let un = () => {};
    un = w.layers.register(() => un());
    w.setOnGuard(false);
    w.layers.onPopState(back());
    w.flush();
    expect(w.log).toEqual(['pushGuard']);
    expect(w.layers.size()).toBe(0);
  });

  it('a layer that ignores its dismissal does not trap Back', () => {
    const w = world();
    w.layers.register(() => {});
    w.setOnGuard(false);
    w.layers.onPopState(back());
    expect(w.timers[0]!.ms).toBe(DISMISS_GRACE_MS);
    w.flush();
    expect(w.log).toEqual(['pushGuard', 'step back']);
  });

  it('a layer closing by Esc / click never touches history (no async back to race a navigation)', () => {
    const w = world();
    const un = w.layers.register(() => {});
    un();
    expect(w.log).toEqual(['pushGuard']);
    expect(w.timers).toEqual([]);
  });

  it('with no layer open a guard is transparent, whichever way it is reached', () => {
    const w = world();
    w.layers.onPopState({ dir: 'back', leftGuard: false, onGuard: true });
    w.flush();
    w.layers.onPopState({ dir: 'forward', leftGuard: false, onGuard: true });
    w.flush();
    w.layers.onPopState({ dir: 'back', leftGuard: true, onGuard: false });
    expect(w.log).toEqual(['step back', 'step forward', 'step back']);
  });

  it('stepping over a guard lands on the page and STOPS — it does not skip the page it was heading to', () => {
    const w = world();
    // [P, guard, N]: Back from N arrives on the guard, which is stepped over...
    w.layers.onPopState({ dir: 'back', leftGuard: false, onGuard: true });
    // ...and the traversal that caused lands on P, having left the guard going back. P is the destination.
    w.layers.onPopState({ dir: 'back', leftGuard: true, onGuard: false });
    expect(w.log).toEqual(['step back']);
  });

  it('a pass that never lands (Forward past the last entry) expires instead of eating the next Back', () => {
    const w = world();
    w.layers.onPopState({ dir: 'forward', leftGuard: false, onGuard: true });
    w.flush(); // the window closes
    w.layers.onPopState({ dir: 'back', leftGuard: true, onGuard: false });
    // The person was sitting on that guard: Back lands on the page itself, so go one further.
    expect(w.log).toEqual(['step forward', 'step back']);
  });

  it('an ordinary Back with no guard involved is left alone', () => {
    const w = world();
    w.layers.onPopState({ dir: 'back', leftGuard: false, onGuard: false });
    w.layers.onPopState({ dir: 'none', leftGuard: false, onGuard: false });
    expect(w.log).toEqual([]);
  });

  it('an ordinary Back while a layer is open on a page with no guard is left alone', () => {
    const w = world();
    w.layers.register(() => {});
    w.layers.onPopState({ dir: 'back', leftGuard: false, onGuard: false });
    expect(w.timers).toEqual([]);
  });
});

describe('a layer that asks before closing (unsaved edits, #962 r)', () => {
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it('"Keep editing" consumes the Back, keeps the layer, and puts the guard back — the page is not left', async () => {
    const w = world();
    w.layers.register(async () => false);
    w.setOnGuard(false);
    w.layers.onPopState(back());
    await settled();
    w.flush();
    expect(w.log).toEqual(['pushGuard', 'pushGuard']); // opened, then re-guarded
    expect(w.layers.size()).toBe(1);
  });

  it('"Discard" closes it like any other layer', async () => {
    const w = world();
    let un = () => {};
    un = w.layers.register(async () => {
      un();
      return true;
    });
    w.setOnGuard(false);
    w.layers.onPopState(back());
    await settled();
    w.flush();
    expect(w.log).toEqual(['pushGuard']);
    expect(w.layers.size()).toBe(0);
  });
});
