/*
 * #820 — docs analytics behaviour. Inlined into the page head by astro.config.mjs ONLY when
 * PUBLIC_POSTHOG_KEY is set, after posthog.init, so with the key unset not one byte of this
 * ships (the #946 gating). Plain functions at the top level so scripts/analytics-behaviour.test.mjs
 * can load and exercise them without a browser; everything that touches the DOM is in sdBoot().
 *
 * No identifier is attached to anything here: PostHog runs with memory persistence, and the
 * events carry only the page path, the search query and a count.
 */
var SD_APP_ORIGIN = 'https://app.storyos.dev';

/** The three links from docs to the app carry where in the docs they were clicked. */
function sdMediumFor(el) {
  if (el.closest('footer')) return 'footer';
  if (el.closest('header, nav, .sidebar, mobile-starlight-toc, starlight-menu-button')) return 'nav';
  return 'inline';
}

/** Adds utm_source/medium/campaign to an app link. An author's own utm_* is never overwritten; any other URL is returned untouched. */
function sdAppLinkWithUtm(href, medium, path) {
  try {
    var url = new URL(href);
    if (url.origin !== SD_APP_ORIGIN) return href;
    if (!url.searchParams.has('utm_source')) url.searchParams.set('utm_source', 'docs');
    if (!url.searchParams.has('utm_medium')) url.searchParams.set('utm_medium', medium);
    if (!url.searchParams.has('utm_campaign')) url.searchParams.set('utm_campaign', path);
    return url.toString();
  } catch (e) {
    return href;
  }
}

/** Pagefind's own summary line: "N results for …", "1 result for …", "No results for …". null while it is still searching. */
function sdResultCount(message) {
  var text = String(message || '').trim();
  var found = /^(\d[\d,]*)\s+results?\s+for\b/i.exec(text);
  if (found) return Number(found[1].replace(/,/g, ''));
  if (/^no results?\b/i.test(text)) return 0;
  return null;
}

function sdBoot() {
  var path = location.pathname;

  // 3. every link from the docs to the app, applied once, centrally.
  document.querySelectorAll('a[href^="' + SD_APP_ORIGIN + '"]').forEach(function (a) {
    a.setAttribute('href', sdAppLinkWithUtm(a.getAttribute('href'), sdMediumFor(a), path));
  });

  // 1. searches: observe the search dialog's result summary and report once per settled query.
  var last = '';
  var timer = null;
  function report() {
    var dialog = document.querySelector('site-search dialog');
    if (!dialog) return;
    var message = dialog.querySelector('.pagefind-ui__message');
    var input = dialog.querySelector('.pagefind-ui__search-input');
    if (!message || !input) return;
    var query = input.value.trim().slice(0, 200);
    var count = sdResultCount(message.textContent);
    if (!query || count === null) return;
    var key = query + '|' + count;
    if (key === last) return;
    last = key;
    posthog.capture('docs_search_performed', { query: query, result_count: count });
  }
  var host = document.querySelector('site-search');
  if (host) {
    new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(report, 700);
    }).observe(host, { childList: true, subtree: true, characterData: true });
  }

  // 2. "Was this helpful?" on every content page, once per vote.
  var content = document.querySelector('.sl-markdown-content');
  if (content && content.parentNode) {
    var box = document.createElement('div');
    box.id = 'sd-helpful';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Was this page helpful?');
    box.style.cssText =
      'display:flex;align-items:center;gap:0.5rem;margin-top:2rem;padding-top:1rem;border-top:1px solid var(--sl-color-hairline);font-size:var(--sl-text-sm);color:var(--sl-color-gray-2)';
    box.innerHTML = '<span>Was this page helpful?</span>';
    [['Yes', true], ['No', false]].forEach(function (choice) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice[0];
      button.style.cssText =
        'cursor:pointer;padding:0.15rem 0.7rem;border:1px solid var(--sl-color-gray-5);border-radius:0.4rem;background:transparent;color:inherit;font:inherit';
      button.addEventListener('click', function () {
        posthog.capture('docs_page_rated', { helpful: choice[1], path: path });
        box.textContent = 'Thanks, noted.';
        box.setAttribute('role', 'status');
      });
      box.appendChild(button);
    });
    content.parentNode.insertBefore(box, content.nextSibling);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sdBoot);
  else sdBoot();
}
