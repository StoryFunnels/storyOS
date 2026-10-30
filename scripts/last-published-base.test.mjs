import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBase } from './last-published-base.mjs';

// Linear history a <- b <- c <- d <- e: an earlier commit is an ancestor of a later one.
const order = ['a', 'b', 'c', 'd', 'e'];
const ancestorOf = (sha, head) => order.indexOf(sha) < order.indexOf(head);

test('a cancelled previous run is skipped: the base is the last commit that published', () => {
  // c's run was cancelled, so the newest successful run is b's — not `before` (c).
  assert.deepEqual(pickBase(['b', 'a'], 'd', ancestorOf, 'c'), { base: 'b', from: 'last published' });
});
test('the normal case: the previous push published, so the base equals `before`', () => {
  assert.deepEqual(pickBase(['c', 'b'], 'd', ancestorOf, 'c'), { base: 'c', from: 'last published' });
});
test('a re-run of an old commit never diffs against its own descendant', () => {
  // Re-running b: d and c published later; the first strict ancestor is a.
  assert.deepEqual(pickBase(['e', 'd', 'c', 'a'], 'b', ancestorOf, 'a'), { base: 'a', from: 'last published' });
});
test('HEAD itself is never its own base (re-run of the newest run)', () => {
  assert.deepEqual(pickBase(['d', 'c'], 'd', ancestorOf, 'c'), { base: 'c', from: 'last published' });
});
test('no usable candidate falls back (empty fallback = rebuild everything)', () => {
  assert.deepEqual(pickBase([], 'd', ancestorOf, 'c'), { base: 'c', from: 'fallback' });
  assert.deepEqual(pickBase(['x'], 'd', () => false, ''), { base: '', from: 'fallback' });
});
