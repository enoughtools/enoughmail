# Aspect ratio, direction, and avatars

These families share presentation rules between React and native Astro. Native components render without hydration; interactive behavior stays in React islands.

## AspectRatio

Both renderers accept a positive numeric `ratio` (default `1`). Invalid values use a square ratio. Both preserve a fluid-width outer wrapper and a positioned content region; custom classes and styles apply to that content region. React forwards Radix's `asChild` and refs. Astro supports normal element attributes and its default slot.

## DirectionProvider

React accepts `direction="ltr" | "rtl"` and the `dir` alias. `direction` takes precedence when both are supplied. The provider sets Radix context without adding a DOM wrapper; set HTML `dir` on the containing element for text and CSS layout.

Native Astro emits a `div` with the resolved `dir`, or the element selected by `as`. Its HTML direction is inherited by descendants, but React context cannot cross separate Astro island boundaries. Wrap any React island that uses `useDirection()` or direction-aware Radix primitives in the React provider inside that island.

## Avatar

Both renderers expose `Avatar`, `AvatarImage`, `AvatarFallback`, `AvatarBadge`, `AvatarGroup`, and `AvatarGroupCount`, with shared `default`, `sm`, and `lg` sizes.

React's image and fallback components track loading and failure through Radix. Native Astro's compositional parts are deterministic HTML: render an image or a fallback according to server-known availability. Rendering both parts displays both; no browser load-state handling is implied. Use the React Avatar family in an island when browser image failure must switch to initials.

```astro
---
import Avatar from '@enoughtools/ui-astro/avatar';
import AvatarImage from '@enoughtools/ui-astro/avatar-image';
import AvatarFallback from '@enoughtools/ui-astro/avatar-fallback';
const imageAvailable = true;
---
<Avatar>
  {imageAvailable
    ? <AvatarImage src="/alex.jpg" alt="Alex Morgan" />
    : <AvatarFallback>AM</AvatarFallback>}
</Avatar>
```

The Astro root also accepts convenience `src`, `alt`, and `fallback` props, plus named `fallback` and `badge` slots. When composing the default slot without convenience props, the root adds no image or empty fallback. Badges and overflow counts remain static presentation in either renderer.
