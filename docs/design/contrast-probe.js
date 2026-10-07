/**
 * Contrast + palette probe. Paste into the browser console on any StoryOS page.
 *
 * Why a console snippet and not a test: contrast depends on COMPOSITED colour —
 * a token at 13% alpha over whatever surface happens to be behind it — and this
 * repo has no browser test harness (vitest, no jsdom, and jsdom does no layout
 * anyway, see z-scale.unit.test.ts's note). So the honest reproducible artefact
 * is a snippet a person runs in a real browser, in a stated theme.
 *
 * Run it once per theme. It reports every text node that fails WCAG AA against
 * its own effective background, deduplicated by colour pair and size.
 *
 * Written for docs/design/dark-mode-review-2026-09-08.md — the numbers in that
 * document came from this.
 */
(() => {
  const parse = (c) => {
    const m = (c || '').match(/-?[\d.]+/g);
    if (!m) return null;
    const [r, g, b, a] = m.map(Number);
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (f, b) => ({
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
    a: 1,
  });
  /* Walks ancestors compositing translucent layers, because a chip painted at
     13% alpha has no contrast of its own — only against what is behind it. */
  const effBg = (el) => {
    let n = el, acc = null;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 1) return acc; }
      n = n.parentElement;
    }
    const root = parse(getComputedStyle(document.documentElement).backgroundColor)
      || { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, root) : root;
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  const rows = [];
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length || !el.textContent.trim()) return;
    if (el.closest('script,style,noscript')) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.opacity === '0') return;
    const fgRaw = parse(s.color);
    if (!fgRaw) return;
    const bg = effBg(el);
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const px = parseFloat(s.fontSize), w = parseInt(s.fontWeight) || 400;
    /* WCAG "large text": >=24px, or >=18.66px at >=700. Those need 3:1, not 4.5. */
    const large = px >= 24 || (px >= 18.66 && w >= 700);
    const cr = ratio(fg, bg);
    rows.push({
      text: el.textContent.trim().slice(0, 30), px, weight: w,
      fg: hex(fg), bg: hex(bg),
      contrast: Math.round(cr * 100) / 100,
      needs: large ? 3 : 4.5,
      pass: cr >= (large ? 3 : 4.5),
      inRichText: !!el.closest('.bn-container'),
    });
  });

  const fails = rows.filter((r) => !r.pass).sort((a, b) => a.contrast - b.contrast);
  const seen = new Set(), unique = [];
  for (const f of fails) {
    const k = f.fg + f.bg + f.px;
    if (!seen.has(k)) { seen.add(k); unique.push(f); }
  }
  const out = {
    theme: document.documentElement.getAttribute('data-theme') || '(system)',
    measured: rows.length,
    failing: fails.length,
    uniqueFailures: unique,
  };
  console.table(unique);
  return out;
})();
