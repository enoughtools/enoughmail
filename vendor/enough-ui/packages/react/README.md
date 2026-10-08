# EnoughUI

[![EnoughUI. Enough to build on. Components for React and Astro, with square edges, clear type, and shared foundations.](https://raw.githubusercontent.com/enoughtools/enough-ui/v0.5.0/docs/assets/repository/repo-hero.png)](https://enoughui.com)

**[Explore the live demo](https://enoughui.com)** · [React on npm](https://www.npmjs.com/package/@enoughtools/ui-react) · [Astro on npm](https://www.npmjs.com/package/@enoughtools/ui-astro)

EnoughUI is a component library for React, Astro and SwiftUI, with proportional typography, square shapes, and shared design tokens. Fine rules, paper surfaces, editorial serif headings, and purposeful indigo give it a clear visual language. It follows shadcn/ui’s Radix component catalog while preserving EnoughUI’s identity.

[![Real EnoughUI Storybook examples: a questionnaire, a visitors chart, a native Astro card, and an open framework combobox.](https://raw.githubusercontent.com/enoughtools/enough-ui/v0.5.0/docs/assets/repository/component-overview.png)](https://enoughui.com)

Try the components, switch renderers, inspect their source, and make them yours in the [live catalog](https://enoughui.com). These previews come from the same stories used in rendering and interaction checks. The [Enough brand resources](https://brand.enoughtools.com) provide the approved logo, palette, and typography.

## Choose your renderer

| Package | Use | Runtime |
| --- | --- | --- |
| `@enoughtools/ui-react` | React components and interactive islands in Astro | React 19 |
| `@enoughtools/ui-astro` | Native presentational components | Astro; no React dependency |
| `EnoughUI` | Native Apple apps | SwiftUI; macOS 13+, iOS/iPadOS 16+ |

Both web packages include compiled CSS and their own component entry points. Native Astro components render HTML without hydration. Interactive controls use the same React implementation in React apps and Astro islands, so their state and accessibility behavior stay consistent.

The [parity contract](https://github.com/enoughtools/enough-ui/blob/v0.5.0/docs/parity.md) records the pinned upstream catalog, required exports, renderer mapping, and intentional differences. A catalog or export count alone does not establish behavioral parity. The project verifies source contracts, story rendering, interactions, browser accessibility, and isolated package consumers.

[CountryHeatmap](https://github.com/enoughtools/enough-ui/blob/v0.5.0/docs/country-heatmap.md) adds a responsive world map with shared color scales and an exact-value table in both React and native Astro. It uses public-domain Natural Earth boundaries and works without hydration. [Try the country heatmap](https://enoughui.com/?path=/catalog/country-heatmap).

## SwiftUI

Add `https://github.com/enoughtools/enough-ui.git` in Xcode's **Add Package Dependencies** and select the **EnoughUI** product from version 0.5.0 onward. Swift Package Manager installs directly from the same Git release tags as the web packages.

```swift
import SwiftUI
import EnoughUI

EnoughThemeProvider {
    EnoughCard {
        EnoughCardHeader("Welcome", description: "Make yourself at home.")
        EnoughButton("Get started", variant: .primary) { /* Your action */ }
    }.padding()
}
```

The [Swift guide](https://github.com/enoughtools/enough-ui/blob/v0.5.0/packages/swift/README.md) covers the component API, native equivalents, platform differences, theming and installation. Run `swift run --package-path examples/swift-catalog EnoughUICatalog` for the native examples. The Swift library has no third-party dependencies and does not need Node or npm. Its palette is generated from the shared web theme. Native system controls retain their Apple behavior and styling.

Browse the dedicated [Swift gallery](https://enoughui.com/swift) for 24 component families, real macOS and iPhone captures in light and dark appearance, complete Swift examples, and installation instructions. The screenshots and runnable native demo share the same compiled fixtures. React and Astro continue to share the web gallery.

## React

```sh
pnpm add @enoughtools/ui-react react react-dom
```

```tsx
import { Button, Card, CardContent } from '@enoughtools/ui-react';
import '@enoughtools/ui-react/styles.css';

export function Example() {
  return (
    <Card>
      <CardContent>
        <Button variant="accent" onClick={() => console.log('Saved')}>Save</Button>
      </CardContent>
    </Card>
  );
}
```

Import individual modules when preferred:

```tsx
import { Button, type ButtonProps } from '@enoughtools/ui-react/button';
import { Calendar } from '@enoughtools/ui-react/calendar';
import { Toaster, toast } from '@enoughtools/ui-react/sonner';
```

The React root exports the legacy toast implementation as `Toaster`/`toast` and Sonner as `SonnerToaster`/`sonnerToast`. The individual `sonner` module follows shadcn’s `Toaster`/`toast` names. Components retain `"use client"` directives where applicable, and React is a peer dependency rather than bundled code.

## Astro

```sh
pnpm add @enoughtools/ui-astro
```

```astro
---
import Button from '@enoughtools/ui-astro/button';
import Card from '@enoughtools/ui-astro/card';
import CardContent from '@enoughtools/ui-astro/card-content';
import '@enoughtools/ui-astro/styles.css';
---
<Card>
  <CardContent>
    <Button href="/start" variant="accent">Get started</Button>
  </CardContent>
</Card>
```

Native components accept `class`, native HTML attributes, and slots. Shared variant names and base styles match React. Use native tags and slots in place of React’s `asChild`. `Button` renders an anchor for `href`; disabled anchors lose their destination and keyboard focus. Native buttons default to `type="button"`.

For stateful controls, install `@enoughtools/ui-react`, `@astrojs/react`, React and React DOM, configure the Astro React integration, and hydrate a small React composition:

```tsx
// DateControl.tsx
import { DatePicker } from '@enoughtools/ui-react/date-picker';

export default function DateControl() {
  return <DatePicker label="Appointment date" />;
}
```

```astro
---
import DateControl from './DateControl';
import '@enoughtools/ui-astro/styles.css';
---
<DateControl client:load />
```

Use `client:load` when immediate interaction matters, or `client:visible` for controls farther down the page. React context-based primitives belong together in one island. The native Astro package does not install React, Radix, or the interactive control dependencies.

## Styles

Import one stylesheet from either renderer package:

- `styles.css`: theme, component utilities, Preflight, body styling, square-corner reset, and reduced-motion rules.
- `components.css`: theme and component utilities without Preflight or global body/corner styling. Your app supplies its own reset, including border-box sizing.

No Tailwind setup is required in a consumer. Additional utilities you supply must be generated by your application; compiled library utilities share normal Tailwind class names.

```css
:root {
  --color-accent: #6d28d9;
  --color-accent-soft: #f5f3ff;
  --font-sans: "Inter", system-ui, sans-serif;
}
```

The defaults are Space Grotesk and Libre Caslon Text with system fallbacks. Font files and remote font requests are not bundled. Typography is proportional throughout, including keyboard hints, numbers, code treatments, and chart labels. The compatibility token `--font-mono` resolves to `--font-sans`.

Navigation, branding, destinations, and actions come from the consuming application. `TopNav` starts with no application-specific links; `brand`, `homeLabel`, `links`, and `skipToHref` configure it. `ToolRow` can use an explicit icon or text tile; its React `domain` option requests a favicon from Google.

## Develop locally

Use Node 22.14+ and pnpm 10.34.5. Source in `src/` is the source of truth. The root `@rebnz/enough-ui` name is a private compatibility package for development; the two web renderer packages are released on npm, and the Swift product is released through Git tags and SwiftPM.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm check:astro
pnpm test
pnpm exec playwright install chromium
pnpm build-storybook
pnpm verify:previews
pnpm verify:catalog
pnpm verify:package
pnpm verify:browser
```

`pnpm build` refreshes root `dist/` and both renderer packages. Run it before tests that import compiled artifacts. Package verification creates temporary isolated consumers and needs npm registry access. Browser verification requires Chromium (`pnpm exec playwright install chromium`).

For another local project, use a directory dependency on the generated renderer directory:

```sh
pnpm add /absolute/path/to/enough-ui/packages/react
# or
pnpm add /absolute/path/to/enough-ui/packages/astro
```

Rebuild after source changes. Local development must follow the directory or an automatically refreshed source snapshot, rather than a fixed versioned tarball. Release verification intentionally tests packed archives to check what npm users receive.

## Component catalog

```sh
pnpm storybook
```

The public catalog lives at [enoughui.com](https://enoughui.com), with `ui.enoughtools.com`, `enoughui.reb.run` and `www.enoughui.com` permanently redirecting to the same path on the canonical domain. Its custom Storybook manager provides component search, category filters, live React/Astro previews, example selection, source, responsive previews, and controls for supported story arguments. Source uses a read-only Monaco viewer with syntax highlighting, line numbers, search, wrapping, and separate native Astro files. Its scripts and workers are hosted with the site and load when Source opens. The **Storybook** link on a component opens the standard manager with full controls, docs, and accessibility tools.

One [Storybook Astro](https://storybook-astro.org/) catalog contains the native **Astro** stories and **UI** React stories. Portable rendering tests reuse those stories, and browser tests use the built catalog. A static build goes to `storybook-static/`; there is no separate showcase application. The catalog manifest is generated from those same source fixtures before development and production builds.

Every component tile includes a preview image captured from a real story. `build-storybook` regenerates those images with Playwright after compiling the stories, then includes them in the deployed assets. Install Chromium with `pnpm exec playwright install chromium` before the first build. Local development falls back to a live story when generated images are unavailable.

```sh
pnpm build-storybook
pnpm verify:catalog
pnpm verify:source
pnpm verify:previews
pnpm verify:stories
pnpm deploy:catalog
```

Deployment uses Cloudflare Workers static assets with the custom domains in `wrangler.jsonc`. Authenticate Wrangler to the account that owns `enoughtools.com` and `reb.run` before publishing. `deploy:catalog` rebuilds the renderer packages and Storybook before uploading. Catalog browser checks save screenshots and a report in `artifacts/catalog/`.

See [contributing](https://github.com/enoughtools/enough-ui/blob/v0.5.0/CONTRIBUTING.md) for component, parity, accessibility, and review requirements; [release instructions](https://github.com/enoughtools/enough-ui/blob/v0.5.0/docs/releasing.md) for npm setup and publishing; and [security policy](https://github.com/enoughtools/enough-ui/blob/v0.5.0/SECURITY.md) for reporting vulnerabilities.

## License

[MIT](https://github.com/enoughtools/enough-ui/blob/v0.5.0/LICENSE), with upstream attribution in [third-party notices](https://github.com/enoughtools/enough-ui/blob/v0.5.0/THIRD_PARTY_NOTICES.md).
