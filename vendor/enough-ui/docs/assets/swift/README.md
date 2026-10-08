# Swift gallery captures

These PNGs are actual SwiftUI renderings from the native demo's compiled fixtures in `examples/swift-catalog/Sources/EnoughUICatalog/Gallery/`.

- `*-macos-{light,dark}.png`: NSHostingView/AppKit hierarchy, 640-point content width.
- `*-ios-{light,dark}.png`: UIHostingController/UIKit hierarchy on an isolated iPhone 16 simulator, 390-point content width.

Native menus, selection sheets and dialogs are shown by their trigger controls; the page labels that state and links to the interactive native demo. iPad is supported by the package, but these mobile screenshots are explicitly iPhone captures.

Regenerate on an Apple Silicon Mac with Xcode and an installed iOS simulator runtime:

```sh
pnpm capture:swift-gallery
```

The capture script creates, boots and deletes its own simulator. It does not use or alter other simulator devices. Committed images let Linux CI and public-site builds use real native previews without an Apple toolchain. `provenance.json` records the capture environment and source hashes. `build-swift-gallery.mjs` refuses stale captures.

The gallery remains a dedicated page in the existing Storybook site. No additional public showcase application or web imitation of SwiftUI controls is built.
