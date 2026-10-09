import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The behaviour script is a plain browser script (inlined into the head), so load it as text and
// return its top-level helpers. `document` is undefined here, so sdBoot is never invoked.
const source = readFileSync(new URL('../src/scripts/analytics-behaviour.js', import.meta.url), 'utf8');
const { sdAppLinkWithUtm, sdResultCount } = new Function(`${source}; return { sdAppLinkWithUtm, sdResultCount };`)();

test('an app link gets utm_source=docs, the medium, and the page path as campaign', () => {
  const out = new URL(sdAppLinkWithUtm('https://app.storyos.dev/signup', 'nav', '/guides/webhooks/'));
  assert.equal(out.searchParams.get('utm_source'), 'docs');
  assert.equal(out.searchParams.get('utm_medium'), 'nav');
  assert.equal(out.searchParams.get('utm_campaign'), '/guides/webhooks/');
  assert.equal(out.pathname, '/signup');
});

test('an author-written utm_* is never overwritten', () => {
  const out = new URL(sdAppLinkWithUtm('https://app.storyos.dev/?utm_source=partner&utm_medium=email', 'inline', '/x'));
  assert.equal(out.searchParams.get('utm_source'), 'partner');
  assert.equal(out.searchParams.get('utm_medium'), 'email');
  assert.equal(out.searchParams.get('utm_campaign'), '/x');
});

test('only the app origin is rewritten', () => {
  for (const href of ['https://github.com/StoryFunnels/storyOS', 'https://app.storyos.dev.evil.example/', '/local', 'not a url']) {
    assert.equal(sdAppLinkWithUtm(href, 'inline', '/x'), href);
  }
});

test('result counts come from Pagefind’s summary line, and zero results count as zero', () => {
  assert.equal(sdResultCount('12 results for “webhook”'), 12);
  assert.equal(sdResultCount('1 result for “webhook”'), 1);
  assert.equal(sdResultCount('1,204 results for “a”'), 1204);
  assert.equal(sdResultCount('No results for “zzzz”'), 0);
});

test('a summary that is not a result line is not reported (still searching, or empty)', () => {
  assert.equal(sdResultCount(''), null);
  assert.equal(sdResultCount(null), null);
  assert.equal(sdResultCount('Loading…'), null);
});
