import { describe, expect, it } from 'vitest';
import { elementAt, pathWithin } from './scroll-memory';

/** Just enough of an Element: a parent, children, and the pieces `pathWithin` reads. */
interface Fake {
  children: Fake[];
  parentElement: Fake | null;
}
const asEl = (f: Fake) => f as unknown as Element;
function tree() {
  const mk = (): Fake => ({ children: [], parentElement: null });
  const root = mk(), a = mk(), b = mk(), b0 = mk(), b1 = mk();
  for (const [p, c] of [[root, a], [root, b], [b, b0], [b, b1]] as const) {
    c.parentElement = p;
    p.children.push(c);
  }
  return { root, a, b, b0, b1 };
}

describe('scroll memory paths (#962 q)', () => {
  it('names a container by its child indices from <main> and finds it again', () => {
    const { root, b1, a } = tree();
    expect(pathWithin(asEl(root), asEl(b1))).toBe('1.1');
    expect(pathWithin(asEl(root), asEl(a))).toBe('0');
    expect(pathWithin(asEl(root), asEl(root))).toBe('');
    expect(elementAt(asEl(root), '1.1')).toBe(asEl(b1));
  });
  it('a container outside <main>, or a path that no longer exists, resolves to nothing (left alone)', () => {
    const { root } = tree();
    const stranger: Fake = { children: [], parentElement: { children: [], parentElement: null } };
    expect(pathWithin(asEl(root), asEl(stranger))).toBeNull();
    expect(elementAt(asEl(root), '2.0')).toBeNull();
    expect(elementAt(asEl(root), '1.5')).toBeNull();
  });
});
