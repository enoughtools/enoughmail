# EnoughUI brand assets

These are the approved EnoughUI assets from the Enough branding pack, version 1.0.0 (October 3, 2026). The complete public guide and download are available at [brand.enoughtools.com](https://brand.enoughtools.com).

The ink, blue, and reverse EnoughUI lockups, square `e.` marks, and favicon are copied unchanged from the pack. Their SVG lettering is outlined, so logos remain consistent without an installed or remote font. Use ink on light surfaces and reverse on ink or indigo. Preserve the tile, letter shapes, period, descriptor weight, spacing, and proportions. Leave at least half the mark's height clear on every side; a full lockup needs a mark height of at least 32 px, and the standalone mark needs at least 24 px. Use the favicon asset for browser icons.

The palette is ink `#12151c`, paper `#f4f5f8`, white `#ffffff`, and indigo `#3b4fe4`. Keep blue purposeful in selected states, focus, actions, and occasional brand detail. The structure uses square edges, fine rules, generous spacing, and proportional typography.

[fonts.css](fonts.css) loads the supplied variable WOFF2 files for the repository catalog: Space Grotesk (weights 300–700) and Libre Caslon Text (weights 400–700). These fonts and the catalog brand files remain outside the released renderer packages. Library consumers choose their own font loading and fallbacks.

The repository [hero source](../repository/hero.svg) uses the unchanged outlined lockup and mark, with additional lettering outlined from the pack's Space Grotesk Regular/Medium and Libre Caslon Text Regular instances. [social-preview.svg](social-preview.svg) contains the same artwork; [social-preview.png](social-preview.png) is its opaque 1280×640 raster export for GitHub. The hero artwork includes the public demo address without a decorative arrow or fixed component count.

The [component overview](../repository/component-overview.png) combines current, real Storybook captures. [stories.json](../repository/stories.json) records their source fixtures and capture dimensions. The examples contain synthetic demonstration content. The chart's test-opened disclosure and keyboard focus were restored to their initial presentation before capture; no component markup or appearance was fabricated.

Artwork and documentation are covered by the supplied [MIT license](LICENSE). Fonts use the SIL Open Font License 1.1; retain the [Space Grotesk notice](fonts/SpaceGrotesk-OFL.txt) and [Libre Caslon Text notice](fonts/LibreCaslonText-OFL.txt) with redistributed font files. Space Grotesk is by Florian Karsten. Libre Caslon Text credits Pablo Impallari, Rodrigo Fuenzalida, and Katja Schimmel. The font sources are the official Google Fonts distributions for [Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk) and [Libre Caslon Text](https://github.com/google/fonts/tree/main/ofl/librecaslontext).
