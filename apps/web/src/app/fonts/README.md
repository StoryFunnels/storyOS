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
Figtree, Inter, Source Sans 3, DM Sans, Source Serif 4, Playfair Display and JetBrains Mono are all published under the **SIL Open Font License 1.1** (checked against each family's `METADATA.pb` upstream, not assumed from the other six), which permits redistribution and embedding on condition that the licence travels with the files.

The licence text and each family's own copyright notice are in [`OFL.txt`](./OFL.txt), next to the files. A copy is served at `/licenses/fonts-OFL.txt` (`public/licenses/`) because the woff2 files reach the Docker image through Next's build output, where this directory does not. `lib/self-hosted-fonts.unit.test.ts` fails if either copy is missing, if they differ, or if a family loses its notice.

## Changing a font
Edit `fonts.css`, add or replace the woff2 here, and keep the `--font-*` variable names: `lib/embed-fonts.ts` and `globals.css` read them. `lib/embed-fonts.unit.test.ts` fails if an embed family offered in the builder has no face here.
