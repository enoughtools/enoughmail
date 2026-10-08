# Contributing to EnoughUI

EnoughUI aims to cover the shadcn/ui component catalog while giving React and Astro users consistent appearance, semantics, and accessible behavior. Contributions to components, tests, documentation, and accessibility are welcome. Read the [code of conduct](CODE_OF_CONDUCT.md) before participating and the [security policy](SECURITY.md) before reporting a vulnerability.

## Development

Use Node.js 24 LTS and the pnpm version declared in `package.json`. CI also checks the supported Node.js 22 line. Install from the committed lockfile:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm storybook
```

`src/` is the source of truth. React components live in `src/components/ui/`, native Astro components in `src/astro/`, and shared variants and helpers in `src/lib/`. The build refreshes `dist/` and the two renderer packages under `packages/react/` and `packages/astro/`. Edit source files rather than generated output, and rebuild after changes. Local consumers should use directory dependencies or an automatically refreshed source snapshot.

## Component and renderer policy

Presentational components must have native Astro implementations. Share variants, class names, and design tokens with React; preserve meaningful HTML, accessible names, labels, and slot composition in both renderers. Astro content should render without JavaScript when interaction is unnecessary. Stateful controls belong in React islands, with explicit hydration instructions and documented framework limitations. An island is a supported integration path, not evidence of a native Astro implementation.

Parity means equivalent supported use cases, visual states, and accessibility behavior where each framework permits them. Document differences such as React event props, Astro slots, or client hydration. Do not claim complete parity for a component until its exports, stories, rendering, and interaction have been checked. Link the upstream shadcn/ui component when adding coverage or changing compatibility behavior.

Use proportional sans-serif or serif typography everywhere, including numbers, code treatments, metadata, and keyboard hints. The compatibility token `--font-mono` must remain mapped to `--font-sans`. Use the shared theme for spacing, color, focus treatment, disabled states, and reduced motion.

## Stories and verification

Storybook Astro is the component catalog, alongside React stories. Add examples for both renderers where supported and reuse those stories in rendering tests. Keep examples small enough to demonstrate the actual API. Do not create a separate showcase site.

Run the checks relevant to your change and the full sequence before requesting review:

```sh
pnpm build
pnpm typecheck
pnpm check:astro
pnpm test
pnpm exec playwright install chromium
pnpm build-storybook
pnpm verify:previews
pnpm verify:catalog
pnpm verify:package
pnpm verify:stories
pnpm verify:browser
```

The catalog build captures real story images with Playwright. Install Chromium before its first build; generated previews stay out of Git.

The Swift page lives in the same Storybook manager at `/swift`. Its source examples are compiled files in `examples/swift-catalog/Sources/EnoughUICatalog/Gallery`; the native demo runs those exact views. Run `pnpm capture:swift-gallery` on a Mac with Xcode and an installed iOS simulator to refresh committed native screenshots and their provenance. The command creates and removes its own capture simulator. Website builds use those checked-in captures, and `pnpm verify:swift-gallery` checks the built page, all four appearances, source copying, navigation and accessible mobile layouts. Regenerate captures when changing native example source.

For interactive controls, cover keyboard navigation, focus movement and restoration, accessible state, disabled behavior, and controlled/uncontrolled state where supported. For shared styling, inspect both renderers in light and dark themes, narrow layouts, and visible focus states. Package verification must exercise installed archives in isolated React and Astro projects so repository dependencies cannot hide missing files or dependency declarations.

## Pull requests

Open an issue first for broad API changes or new dependencies so maintainers can discuss the direction. A focused fix can go straight to a pull request. Describe the user-visible problem, resulting behavior, renderer differences, and validation. Include screenshots or a Storybook example for visual changes and a reproduction for regressions. Maintain source attribution when adapting upstream code and update [third-party notices](THIRD_PARTY_NOTICES.md) when needed.

Keep changes focused and commit messages descriptive. Maintainers may squash changes when merging. Generated build output and local artifacts stay out of Git. Contributions are licensed under the project's [MIT license](LICENSE); submit only work you have permission to contribute.

Maintainers follow the [release guide](docs/releasing.md) when changing package versions or publishing.
