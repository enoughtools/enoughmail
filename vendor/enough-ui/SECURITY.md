# Security policy

## Supported versions

See [upstream dependency status](docs/security-status.md) for reviewed dependency findings and any unresolved upstream advisory.

Security fixes target the latest stable release of `@enoughtools/ui-react` and `@enoughtools/ui-astro`. The renderer packages share a version; upgrade both when using both. Prereleases are intended for evaluation and receive fixes through the next prerelease or stable release. Older release lines do not have a separate maintenance commitment.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/enoughtools/enough-ui/security/advisories/new) for suspected vulnerabilities. Include affected package versions, a minimal reproduction, impact, and any workaround. Avoid posting exploit details, credentials, or user data in public issues. If the private reporting form is unavailable, contact a repository administrator through a private contact method on their GitHub profile.

Maintainers will acknowledge reports, investigate them, and coordinate a fix and disclosure with the reporter. Disclosure timing depends on impact and available mitigations. Ordinary rendering bugs, accessibility regressions, and feature requests can use the public issue tracker when they do not expose a vulnerability.

## Release integrity

Official releases come from `enoughtools/enough-ui` and use npm trusted publishing with provenance after the initial package bootstrap. The release workflow validates both package versions, tests the renderer archives, and publishes through the `npm` environment restricted to release tags. The sole-maintainer policy uses CI verification and restricted tag creation without a manual release approval gate; independent review can be added when another trusted maintainer is appointed. Report an unexpected publisher, suspicious archive, or provenance mismatch privately.
