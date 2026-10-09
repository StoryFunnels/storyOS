# Self-hosted fonts (#797)

Seven families, vendored so the build and the running app make **no** request to a font CDN.

| Family | Used for | Files |
|---|---|---|
| Figtree | the app's own UI font (`--font-figtree`) | latin, latin-ext |
| Inter, Source Sans 3, DM Sans, Source Serif 4, Playfair Display, JetBrains Mono | the embedded-form font control (#720), via `--font-embed-*` | latin plus whichever of latin-ext / cyrillic / cyrillic-ext / greek / greek-ext / vietnamese the family ships |

All are **variable** fonts (one file per subset covers the weight range declared in `fonts.css`).

## Provenance
The files are the Google Fonts woff2 files that `next/font/google` had already produced in this repo's own build output (`.next/static/media`), copied under readable names. Nothing was fetched for this change. Each file's `unicode-range` is copied unchanged from the CSS that build emitted.

## Licence
Figtree, Inter, Source Sans 3, DM Sans, Source Serif 4, Playfair Display and JetBrains Mono are all published under the **SIL Open Font License 1.1**, which permits redistribution and embedding. Upstream: https://fonts.google.com (each family's page carries its own licence text).

## Changing a font
Edit `fonts.css`, add or replace the woff2 here, and keep the `--font-*` variable names: `lib/embed-fonts.ts` and `globals.css` read them. `lib/embed-fonts.unit.test.ts` fails if an embed family offered in the builder has no face here.
