# shadcn/ui parity contract

EnoughUI targets the public component surface and documented capabilities of shadcn/ui while retaining its own visual language. The reference is the **Radix catalog at commit [295a1f114a138f23b5dfee0e0c6812394dfeb90c](https://github.com/shadcn-ui/ui/tree/295a1f114a138f23b5dfee0e0c6812394dfeb90c/apps/v4/registry/bases/radix/ui)**, committed October 2, 2026 and verified October 3, 2026.

The [machine-readable baseline](./shadcn-radix-parity.json) accounts for **65 current documented families plus legacy Form compatibility**. It records every named public export of the 61 current Radix registry modules, each source blob, required native Astro components, and behavior that must be reviewed. Date Picker, Data Table and Typography are documented compositions rather than interchangeable upstream modules. Their EnoughUI component APIs are explicitly adopted conveniences. Legacy Toast remains available alongside Sonner; legacy Form follows the upstream React Hook Form adapter.

shadcn/ui also has Base UI and React Aria catalogs. Provider-specific APIs from those catalogs are outside this pinned contract. The current Radix Combobox itself uses Base UI, and Questionnaire and Message Scroller use the upstream headless React primitives. “Radix catalog” identifies the chosen component surface, not a requirement that every family depend on Radix.

## Renderer and package contract

Publishable artifacts are separate:

| Package | Contract |
| --- | --- |
| `@enoughtools/ui-react` | Typed React components, stateful controls, hooks and shared styles. |
| `@enoughtools/ui-astro` | Typed native `.astro` components and shared styles, with no React dependency. |
| Both together | Native Astro layouts with React islands for interactive controls. |

Native Astro components use proportional typography and the same variant definitions, base styles and theme tokens as React. Stateful behavior belongs in React islands. Astro applications can use every family by selecting the appropriate renderer; stateful React components do not have script-free Astro replacements.

| Renderer | Families |
| --- | --- |
| Native Astro | Alert, Aspect Ratio, Attachment, Badge, Breadcrumb, Bubble, Button, Button Group, Card, Country Heatmap, Empty, Field, Input, Input Group, Item, Kbd, Label, Marker, Message, Native Select, Pagination, Progress, Separator, Skeleton, Spinner, Table, Textarea, Typography. |
| Native presentation with optional island behavior | Avatar: deterministic server-rendered image/fallback presentation; browser image-loading detection and delayed fallback require React. |
| React islands | Accordion, Alert Dialog, Calendar, Carousel, Chart, Checkbox, Collapsible, Combobox, Command, Context Menu, Data Table, Date Picker, Dialog, Direction context, Drawer, Dropdown Menu, Form, Hover Card, Input OTP, Menubar, Message Scroller, Navigation Menu, Popover, Questionnaire, Radio Group, Resizable, Scroll Area, Select, Sheet, Sidebar, Slider, Sonner, Switch, Tabs, Toast, Toggle, Toggle Group, Tooltip. |

The manifest is authoritative for each required native component name, including compound parts. Additional native helpers include Direction's HTML wrapper and Popover header/title/description; the interactive Popover remains a React island.

[CountryHeatmap](./country-heatmap.md) is an EnoughUI addition beyond the pinned shadcn catalog. Both renderers share static SVG geometry, color scales, labels, and a native expandable exact-value table; it requires no React island in Astro.

### Legitimate renderer differences

- Astro uses `class`, native HTML attributes and slots; React uses `className`, children and event handlers. React `asChild` composition becomes a real semantic element or an explicit tag/href choice in Astro.
- React refs, hooks, context, controlled state and callback functions have no native server-rendered counterpart. Place the control that needs them inside a React island.
- Native inputs, textareas and selects participate in ordinary HTML forms. They do not require hydration for editing, selection or submission.
- Native Direction support uses inherited HTML `dir`; DirectionProvider and useDirection propagate stateful primitive context in React.
- Native Avatar presentation cannot observe a browser image error or implement a delayed fallback without JavaScript. Use the React family for those cases.
- React Input Group addons can focus their associated input on click. Native compositions should use ordinary label/for relationships when that interaction is required.
- ItemGroup defaults to a semantic group so standalone cards and linked items remain valid. For list semantics, set `role="list"` on the group and `role="listitem"` on item wrappers.

These differences must be documented rather than hidden behind identically named exports with reduced behavior.

## What verification establishes

Run the source coverage check while implementing components:

```sh
node scripts/check-parity.mjs
```

After rebuilding, check the released surfaces:

```sh
pnpm build
node scripts/check-parity.mjs --built
pnpm typecheck
pnpm check:astro
pnpm test
pnpm verify:package
pnpm verify:browser
pnpm build-storybook
pnpm verify:stories
```

The parity gate checks every required React public symbol, including type exports, every required native Astro source file, built JavaScript imports and built native artifacts. This catches missing compound parts and stale output. It is a **structural coverage gate**. Required props and capabilities in the manifest are separate review targets; the export gate does not verify them.

Renderer tests must reuse the shared Storybook catalog. Browser checks must verify meaningful interactions: keyboard navigation, focus restoration, disabled and invalid states, controlled values, form submission, responsive layouts and reduced motion. New static families need native and React rendering coverage. Each stateful family needs behavior coverage appropriate to its upstream primitive.

UI review must also assess usable focus indicators, touch targets, readable content, narrow layouts, overflow, long labels and error recovery. Passing imports or matching a filename does not establish acceptable UX.

The shared catalog browser verifier scans rendered stories for accessibility and proportional typography, then exercises selected keyboard, modal, form, selection, responsive and toast flows. Unit tests cover additional state transitions. These checks establish the tested scenarios; they do not certify every combination of upstream props, locales, container layouts or assistive technologies. Split-package archive tests additionally inspect transitive dependencies and reject React or interactive dependencies in the native Astro artifact.

### Capabilities that require particular attention

| Family | Review beyond exported names |
| --- | --- |
| Combobox | Single/multiple and object-valued selection, filtering, chips, clear controls, keyboard navigation and disabled items. |
| Drawer | Root direction, swipe dismissal, snap points, scroll behavior and focus containment. A styled Dialog is insufficient. |
| Questionnaire | Ordered and controlled navigation, single/multiple/freeform answers, required-item validation, skipping, defaults, reset, shortcuts and FormData. |
| Sidebar | Mobile presentation, controlled/uncontrolled state, collapse modes, shortcut, persistence and all menu/submenu parts. |
| Message Scroller | Follow appended content while respecting a user's scroll position; scroll controls and context hooks. |
| Calendar and Date Picker | Selection modes, date bounds, disabled dates, locale, keyboard focus and restoration. |
| Chart | Recharts composition, responsive/initial sizing, themed configuration, formatter callbacks, tooltips, legends and accessible output. |
| Data Table | Sorting, filtering, pagination, selection, column visibility and controlled/server state. The guide's TanStack composition has a broader contract than a static table. |
| Form | Controller integration and generated label, description, control and error relationships. |
| Item and Field | Header/footer placement, media variants, orientation and nested choice-card layouts in both renderers. |
| Tabs | Vertical and horizontal layout, line/default variants, keyboard activation and focus. |
| Sheet and Navigation Menu | Sheet close-button options, all four sides and focus restoration; Navigation Menu content with and without its shared viewport. |
| Select | Default/small trigger sizes, item-aligned and popper positioning, keyboard selection, disabled options and form values. |
| Switch, Checkbox and Radio Group | Controlled/uncontrolled state, keyboard use, disabled controls, form values, usable pointer targets and direction-aware layout. |
| Tooltip | Portaled content, immediate default opening, explicit delays, focus/Escape behavior and wrapped text within narrow viewports. |
| Scroll Area and Resizable | Horizontal/vertical composition, pointer operation, keyboard focus and resizing, and preserved primitive refs. |
| Marker | Read-receipt/divider composition with icon/content parts and separator/border variants. EnoughUI's text highlight is an additional compatibility treatment. |

The manifest's capability list is a review target. Export coverage does not automatically mark those capabilities as verified. Until their tests and visual review pass, describe progress as catalog/export coverage rather than complete API or UX parity.

## Updating the baseline

1. Pin a new complete upstream commit and record the reference date.
2. Compare the current Radix registry and documented catalog. Keep legacy compatibility entries explicit.
3. Review public exports **and** changed props, compositions and behavior; update the manifest and affected components together.
4. Add or update shared stories and meaningful renderer/browser checks.
5. Rebuild both packages and verify their artifacts before claiming the new baseline.

Existing EnoughUI patterns and branded variants may remain as documented additions. They must not replace a required upstream export or silently accept an unsupported standard variant.
