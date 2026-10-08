# EnoughUI source snapshot

This workspace contains source from the local `@rebnz/enough-ui` library so a
download of Enough Tools can build without a separate checkout or a published UI
package. EnoughUI 0.3.0 is MIT licensed; its license and third-party notices are
included. This compatibility workspace remains private. Preserve those notices
when distributing Enough Tools or bundled applications.

From the Enough Tools root:

```sh
npm run ui:build
npm run ui:sync -- --source /path/to/enough-ui
npm install
```

The build refreshes source from `ENOUGH_UI_SOURCE`, or `../../enough-ui` relative
to the Enough Tools root when that checkout exists. Otherwise it uses this included
snapshot. An explicitly configured but missing source is an error. A refresh
with changed dependency requirements requires `ui:sync` followed by `npm install`.

Source components, shared styles, the TypeScript configuration, build helpers,
renderer package seed manifests, upstream documentation, design rules, and
license/notice files are preserved. Stories and tests plus upstream catalog
tooling are omitted. The upstream build is retained
as `scripts/build.upstream.mjs`; `scripts/build.mjs` changes only tool invocation
from pnpm to the workspace-installed TypeScript and Tailwind CLIs. Tool resolution
starts at this package and uses the root's installed modules when hoisted, so
changed requirements also work if npm installs a package-specific version.
`snapshot.json`
records the source version, revision, dirty state, and content fingerprint without
storing the machine's checkout path.

Generated `dist` files, including the renderer package artifacts in
`packages/react` and `packages/astro`, are rebuilt during setup and are not
committed. The upstream build discovers components and updates compatibility
exports as well as the renderer packages. Components
remain available through the original package entry points and through Open
Cloud's shared UI adapter. Import one upstream stylesheet in each application.
Use proportional typography; the legacy `--font-mono` token maps to sans-serif.

The copied README describes the complete upstream library's development workflow;
Storybook and Astro verification commands belong in that upstream checkout.
