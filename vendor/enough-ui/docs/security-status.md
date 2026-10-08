# Upstream dependency status

Reviewed October 3, 2026. This records specific findings; it is not a blanket security certification.

## Patched development dependency

The lockfile uses devalue 5.9.4 for Astro and its React integration. This includes the maintainer's [5.9.3 security fixes](https://github.com/sveltejs/devalue/releases/tag/v5.9.3). Serialization, script escaping, malformed input rejection, Buffer isolation, and native Astro story rendering were checked after the update. Neither public renderer package declares devalue as a runtime dependency.

## Open upstream advisory

[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) affects http-cache-semantics through 4.2.0; no patched version is published as of this review. Keep the Dependabot alert open.

The installed dependency belongs to the Astro development toolchain. The advisory concerns a shared cache returning another user's cached response after an attacker supplies a `max-stale` directive. The current library and static Storybook catalog provide no authenticated shared-response cache.

Inspection of Astro 7.3.2 found this dependency in build-time remote image handling, using `storable()` and `timeToLive()`, without calls to the vulnerable `satisfiesWithoutRevalidation()` path. EnoughUI's stories do not use Astro's image-processing components. Our assessment is that the current catalog does not exercise the vulnerable path; this is an inference from the installed code and current usage.

Neither public EnoughUI renderer artifact includes this dependency. Applications remain responsible for their framework's dependencies and caching configuration. Reassess if authenticated remote-image fetching, proxying, or shared response caching is introduced, and update the lockfile when an upstream fix becomes available.
