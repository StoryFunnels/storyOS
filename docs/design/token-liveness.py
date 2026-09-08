#!/usr/bin/env python3
"""Which globals.css tokens are actually live? (ticket #623)

A naive `grep -- "--token"` sweep is MISLEADING here and it is worth saying why,
because the first version of this check reported 32 dead tokens when the real
number is 2.

globals.css has two layers. `:root` declares semantic tokens (`--bg-card`), and
`@theme inline` maps them to Tailwind theme keys (`--color-card: var(--bg-card)`)
which Tailwind then compiles into UTILITIES (`bg-card`, `text-card`, …). So a
heavily-used token is referenced by NEITHER its own name NOR the alias name — it
is referenced by a class string that contains neither. Counting names alone
declares the whole colour system dead.

So: a token is live if it is reachable by any of
  1. `var(--token)` in component source,
  2. an `@theme inline` alias whose generated utility is used, or
  3. a real CSS property inside globals.css using it (e.g. the BlockNote
     code-block rules consume `--bg-code` directly, so it is live even though no
     component names it).

A token whose ONLY reference is its own `@theme inline` forwarding line is NOT
live: the alias exists but the utility it generates has no call sites.
"""
import os, re, sys

SRC = 'apps/web/src'
CSS = open(f'{SRC}/app/globals.css', encoding='utf-8').read()
lines = CSS.split('\n')

def block(start_pat):
    """Return the declared property names inside the first block matching start_pat."""
    out, depth, started = [], 0, False
    for l in lines:
        if not started:
            if re.match(start_pat, l):
                started, depth = True, l.count('{') - l.count('}')
            continue
        depth += l.count('{') - l.count('}')
        m = re.match(r'\s*(--[a-z0-9-]+)\s*:', l)
        if m:
            out.append(m.group(1))
        if depth <= 0:
            break
    return out

semantic = sorted(set(block(r'^:root\s*\{')))
theme    = sorted(set(block(r'^@theme inline\s*\{')))

src = []
for dp, _, fn in os.walk(SRC):
    for f in fn:
        if f.endswith(('.tsx', '.ts')) and '.test.' not in f:
            p = os.path.join(dp, f)
            src.append(open(p, encoding='utf-8', errors='replace').read())
BLOB = '\n'.join(src)

# Tailwind's colour utilities that a --color-* theme key generates.
UTIL_PREFIX = ('bg|text|border|ring|fill|stroke|from|to|via|decoration|divide'
               '|outline|shadow|caret|placeholder|accent')

def var_refs(tok):
    return BLOB.count(f'var({tok})') + BLOB.count(f'var({tok},')

def utility_refs(theme_key):
    """--color-card -> count uses of bg-card / text-card / ... (not -card-foo)."""
    if not theme_key.startswith('--color-'):
        return None
    base = theme_key[len('--color-'):]
    return len(re.findall(rf'(?:{UTIL_PREFIX})-{re.escape(base)}(?![-\w])', BLOB))

# which semantic tokens does @theme inline forward?
forwarded = {}
for l in lines:
    m = re.match(r'\s*(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)', l)
    if m:
        forwarded.setdefault(m.group(2), []).append(m.group(1))

rows, dead = [], []
for tok in semantic:
    direct = var_refs(tok)
    via = 0
    for key in forwarded.get(tok, []):
        u = utility_refs(key)
        if u:
            via += u
    # A reference from a real property (`background: var(--bg-code)`) keeps a
    # token alive; a `--other-token: var(--tok)` forwarding line does not, since
    # `via` above already accounts for whether that alias is used.
    in_css = any(
        f'var({tok})' in l and not re.match(r'\s*--[a-z0-9-]+\s*:', l)
        for l in lines
    )
    if direct == 0 and via == 0 and not in_css:
        dead.append(tok)
    else:
        rows.append((tok, direct, via))

print(f'semantic tokens in :root      : {len(semantic)}')
print(f'@theme inline aliases         : {len(theme)}')
ALL_NAMES = set(re.findall(r'^[ \t]*(--[a-z0-9-]+)[ \t]*:', CSS, re.M))
print(f'unique names in globals.css   : {len(ALL_NAMES)}')
print()
print(f'{"token":22s} {"var() refs":>10s} {"via utility":>12s}')
print('-' * 48)
for tok, d, v in sorted(rows, key=lambda r: -(r[1] + r[2])):
    print(f'{tok:22s} {d:10d} {v:12d}')
print()
print(f'DEAD — no var(), no utility, no internal reference ({len(dead)}):')
for t in dead:
    print(f'  {t}')
