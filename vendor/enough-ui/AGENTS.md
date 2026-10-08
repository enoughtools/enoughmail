# EnoughUI design rules

- Use proportional sans-serif or serif typography throughout. Do not introduce monospace fonts, including for labels, metadata, keyboard hints, numbers, or code treatments.
- Keep the legacy `--font-mono` compatibility token mapped to `--font-sans`.
- Loading indicators remain circular spinners in every renderer. Square surface styling, brand motifs and generic icon rules must not change their geometry; animate only the indicator and respect reduced motion.
- Treat the source package as the source of truth. Rebuild `dist` after changes; consumers should use a directory dependency or an automatically refreshed source snapshot instead of a fixed versioned tarball when working locally.

- Provide native Astro components for presentational UI. Share variants and base styles with React; keep stateful controls in React islands. Verify both renderers when changing shared styling.

- Use Storybook Astro for the component catalog, alongside React stories. Do not build a separate showcase site; reuse stories in rendering tests.
