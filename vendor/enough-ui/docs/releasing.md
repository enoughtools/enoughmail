# Releasing EnoughUI

EnoughUI publishes two npm packages and one Swift package with the same version:

| Package | Build directory | Audience |
| --- | --- | --- |
| `@enoughtools/ui-react` | `packages/react/` | React applications and interactive Astro islands |
| `@enoughtools/ui-astro` | `packages/astro/` | Native Astro presentation without a React dependency |
| `EnoughUI` | Root `Package.swift`, sources in `packages/swift/` | SwiftUI for macOS and iOS/iPadOS |

The private root package is the development source. Update its version in `package.json`; `pnpm build` generates the renderer manifests and artifacts. Generated directories are never the source of release edits. A version tag must exactly match the root and both renderer versions. Stable tags such as `v0.3.0` publish to `latest`; tags such as `v0.3.1-rc.1` publish to `next`. Build metadata in release tags is rejected.

## Initial repository setup

These are administrator setup steps; committing the workflows does not configure GitHub or npm.

1. Create `enoughtools/enough-ui` in the EnoughTools GitHub organization. Start the public history from a reviewed clean source snapshot, retain upstream attribution, and keep the existing development history privately for recovery. Review the snapshot for credentials, personal data, private URLs, machine state, and proprietary content before pushing it. If preserving selected history instead, review every exported commit. Rotate any exposed credential rather than relying on deleting it from history.
2. Push the reviewed initial commit to `main`, then protect that branch with required pull requests and the CI checks `verify (22)` and `verify (24)`, including enforcement for administrators. While there is one maintainer, require zero independent approvals and leave required code-owner review disabled so the maintainer can merge a tested pull request. Add independent review after another maintainer is available. Restrict `v*` tag creation to organization administrators and use a separate ruleset that blocks release tag updates and deletion without a bypass.
3. Enable private vulnerability reporting and available secret scanning/push protection. Verify that repository administrators provide the private contact methods described in `SECURITY.md` and `CODE_OF_CONDUCT.md`.
4. Create a GitHub Actions environment named **`npm`** with a custom deployment policy allowing only tags matching `v*`. The sole-maintainer setup has no required reviewer: releases run automatically after verification and require an authorized release tag. Disable administrator environment bypass through the environment settings UI where available; the documented REST environment payload does not provide that setting. Once another trusted maintainer is appointed, the project can adopt independent release review and prevent self-review. No npm write token belongs in this environment or in repository secrets.
5. Make the repository public before using provenance publication, and confirm Actions is enabled with GitHub-hosted runners. CI runs with read permission; only the publishing job can request an OIDC token.

## npm bootstrap and trusted publisher setup

Confirm that the npm organization owns the `@enoughtools` scope and that the maintainers have publishing permission. GitHub organization membership does not grant npm rights. Trusted publishing requires a package to exist, so a maintainer must publish each reviewed initial package once using `npm login` and interactive 2FA. See [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

Build, run the verification sequence below, then create and inspect the archives:

```sh
node scripts/release.mjs pack --tag v0.3.0
```

For a reviewed stable `0.3.0` bootstrap, publish the exact archives:

```sh
npm login
npm publish artifacts/release/enoughtools-ui-react-0.3.0.tgz --access public --tag latest --ignore-scripts
npm publish artifacts/release/enoughtools-ui-astro-0.3.0.tgz --access public --tag latest --ignore-scripts
```

If the initial version is a prerelease, use its actual archive filenames and `--tag next` for **both** publishes. The initial local bootstrap has no GitHub build provenance. Subsequent, new versions use the release workflow and provenance. Do not create placeholder packages that contain a different archive under the intended release version.

After bootstrap, configure a trusted publisher in the settings of **each** npm package:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization | `enoughtools` |
| Repository | `enough-ui` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | Explicitly allow direct `npm publish` |

New publisher configurations default to staged publishing, which this workflow does not use. Ensure direct publication is allowed. After confirming OIDC works, select **Require two-factor authentication and disallow tokens** in each package's publishing settings. Keep personal npm accounts protected with 2FA. The workflow uses Node.js 24 and npm 11; npm documents minimums of Node.js 22.14.0 and npm 11.5.1. Its provenance requires a public repository and public packages. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Preparing a release

1. Update the private root version and describe changes in release notes, including breaking API changes, new component coverage, renderer differences, and migration instructions. All three renderers move together. During `0.x`, communicate breaking changes explicitly; a `1.0.0` release requires a deliberate stability decision.
2. Review component coverage and known exceptions. Catalog presence alone does not establish interaction or accessibility parity. Keep native Astro presentation and React islands clearly documented.
3. Run the complete verification sequence from a clean install:

```sh
pnpm install --frozen-lockfile
node scripts/build-swift-tokens.mjs --check
swift test
swift test -Xswiftc -swift-version -Xswiftc 6
swift build --package-path examples/swift-catalog
xcodebuild -scheme EnoughUI -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
node scripts/pack-swift.mjs
pnpm build
pnpm typecheck
pnpm check:astro
pnpm test
pnpm exec playwright install chromium
pnpm build-storybook
pnpm verify:previews
pnpm verify:catalog
node scripts/release.mjs pack --tag v0.4.0
pnpm verify:package --archives artifacts/release
pnpm verify:stories
pnpm verify:browser --archives artifacts/release
```

Use the intended version in the pack command. Inspect `artifacts/release/release.json`, both archive contents, CSS, exports, dependencies, licenses, and notices. The isolated Astro consumer must succeed without React installed; the React consumer must pass type, build, rendering, and interaction checks. Review relevant stories in both themes, narrow layouts, and keyboard focus states. Generated archives do not belong in Git.

Merge the reviewed release changes into `main` and wait for CI. A designated maintainer can then create an annotated `v<version>` tag on that commit and push it. Tags trigger `.github/workflows/release.yml`; the workflow requires the tagged commit to be part of `main`.

## Automated release behavior

The verification job rebuilds source, validates metadata and version tags, runs React/Astro checks and tests, builds Storybook, and packs the renderer pair. It checks the catalog in a browser for rendering, accessibility, and interaction, and verifies those exact archives in isolated consumers and a browser before uploading them as a GitHub Actions artifact.

The publishing job targets the `npm` environment, which accepts only authorized release tags. In the sole-maintainer setup it proceeds automatically after verification. It downloads the verified archives, checks their hashes and source commit, preflights both registry versions, and publishes with OIDC and provenance. No install cache or long-lived npm token is used for release builds. Package names, repository metadata, versions, registry, visibility, and distribution channel are validated before publication.

After success, inspect both npm package pages, their versions, distribution tags, and provenance links. The workflow creates a GitHub release for the same tag and attaches the verified Swift source archive and SHA256SUMS after npm publication succeeds. Review its generated notes and add the relevant changelog details. Mark prerelease GitHub releases accordingly. Do not announce the release until both renderer packages are available.

## Failure recovery

- **Verification failure:** fix the source before a new release attempt. If no package was published, prefer a new version/tag to keep the audit trail clear. Do not move a tag that already corresponds to a published package.
- **Environment or authentication failure:** check the exact organization, repository, workflow filename, environment tag policy, allowed action, public repository visibility, hosted runner, and `id-token: write`. Correct administrator settings and rerun the failed publishing job. `npm whoami` does not validate OIDC publication.
- **One renderer published:** rerun the failed publishing job while its verified artifact is retained (30 days). The script skips a published version only when registry `dist.integrity` matches the saved archive and publishes the missing renderer. Network and authentication errors stop the preflight; they are never treated as an absent package. A conflicting archive fails the release. See [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
- **Artifact expired or changed:** do not replace an already published version with rebuilt content. Prepare a new shared version, verify both packages, and release it. npm versions cannot be reused.
- **Wrong distribution tag:** the workflow will not move `latest` or `next` backwards or automatically retag a skipped version. A maintainer must review and repair tags explicitly for both packages using authenticated npm administration. A prerelease stays on `next`; promotion requires a new stable version. See [npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/).
- **Faulty published release:** publish a corrected version of both packages and document the impact. Deprecate affected versions with a clear upgrade message when warranted. Keep the original tag and release records for traceability.

## Swift distribution

From 0.5.0 onward, the repository-root `Package.swift` makes the existing Git URL a SwiftPM package. There is no separate Swift registry publication step: the verified `v<version>` tag is the version developers install in Xcode/SwiftPM. Preserve the tag once published. Swift consumers do not need npm.

The reusable Swift workflow checks generated palette freshness, tests macOS rendering and Swift 6 compatibility, builds an independent native consumer and the iOS simulator library, and compiles/tests the exact source archive in a temporary directory. The release waits for this job as well as web verification before publishing. Its source tarball is an additional GitHub download; SwiftPM normally installs from Git.

After the first tagged Swift release, submit `https://github.com/enoughtools/enough-ui.git` through [Swift Package Index](https://swiftpackageindex.com/add-a-package). Its maintainers decide when to accept and index it. A submission does not mean listing is live. Indexing is independent of SwiftPM installation.

CocoaPods, Carthage binaries and Homebrew are not targets for this SwiftUI source library. See the [Swift distribution guide](../packages/swift/README.md#distribution) for the rationale. RepoReach adoption is a separate consuming-product migration.
