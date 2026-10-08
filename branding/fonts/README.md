# Enough typography files

Enough follows EnoughUI: Space Grotesk for wordmarks, body text and interface text; Libre Caslon Text for editorial headings. All typography is proportional, including code, metadata, keyboard hints and numbers. The compatibility `--font-mono` token points to `--font-sans`.

## Source and license

The original variable TTF files were obtained from the official Google Fonts repository. Both report font version 2.000. Each original is retained here so exports can be reproduced without a network request.

| Local source | Official distribution | SHA-256 |
| --- | --- | --- |
| `SpaceGrotesk-Variable.ttf` | [SpaceGrotesk[wght].ttf](https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf) | `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72` |
| `LibreCaslonText-Variable.ttf` | [LibreCaslonText[wght].ttf](https://raw.githubusercontent.com/google/fonts/main/ofl/librecaslontext/LibreCaslonText%5Bwght%5D.ttf) | `c11809dbfd5445886293d89b32bfc2584075c80e77750cf1c284113e36b8b3f4` |

Both families are distributed under the SIL Open Font License 1.1. Copies are included as `SpaceGrotesk-OFL.txt` and `LibreCaslonText-OFL.txt`. Retain these licenses when redistributing the font files. The official license sources are [Space Grotesk OFL.txt](https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/OFL.txt) and [Libre Caslon Text OFL.txt](https://raw.githubusercontent.com/google/fonts/main/ofl/librecaslontext/OFL.txt).

The fonts identify the [Space Grotesk project](https://github.com/floriankarsten/space-grotesk) and the [Libre Caslon project](https://github.com/thundernixon/Libre-Caslon) as their upstream projects. Space Grotesk credits Florian Karsten. Libre Caslon Text credits Pablo Impallari, Rodrigo Fuenzalida and Katja Schimmel.

## Included exports

| File | Exact weight | Use |
| --- | --- | --- |
| `SpaceGrotesk-Regular.ttf` | 400 | Body, interface text and Tools/UI descriptors |
| `SpaceGrotesk-Medium.ttf` | 500 | Supporting emphasis and small labels |
| `SpaceGrotesk-Semibold.ttf` | 650 | Enough wordmark; the exact weight used by the EnoughUI catalog |
| `LibreCaslonText-Regular.ttf` | 400 | Editorial display and headings |
| `SpaceGrotesk-Variable.woff2` | 300–700 | Self-hosted web font |
| `LibreCaslonText-Variable.woff2` | 400–700 | Self-hosted web font |

The static TTFs are real instances of the retained variable fonts. The Semibold filename identifies the 650-weight wordmark instance; it is deliberately heavier than the conventional 600 weight. WOFF2 files preserve the variable originals and their axes. Font copyright and licensing metadata remain embedded.

The SVG logo masters use glyph outlines from these same static instances. They contain no SVG text elements and need no installed font. The PNG logo exports are transparent and rendered from those SVG masters.

## Rebuild

From the branding pack's parent directory, run `python3 branding/source/build_assets.py`. The script needs `fonttools`, `brotli` and `pillow` for Python, plus Node.js and `sharp` for rendering. It uses the retained local TTFs, writes static fonts and WOFF2 exports, and rebuilds the shared tokens, SVGs and PNGs. Use `--fonts-only` to rebuild only the font exports.

The defaults locate Node and Sharp in the Codex desktop dependency bundle. For another environment, supply `--node /path/to/node --sharp /path/to/node_modules/sharp`. No network access is needed once these dependencies are installed. Font timestamps are preserved, and a second full build was verified to produce byte-identical outputs.

Web consumers can import `../tokens/enough.css`, which provides self-hosted `@font-face` declarations, the exact EnoughUI color/font/shadow tokens, and scoped `.enough-brand` type styles. It does not apply a global reset.
