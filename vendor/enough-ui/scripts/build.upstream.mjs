import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildRendererPackages, componentNames, astroComponentNames, hookNames, rootExports } from './renderer-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = join(root, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const reactNames = await componentNames(root);
const astroNames = await astroComponentNames(root);
const hooks = await hookNames(root);

await rm(join(root, 'dist'), { recursive: true, force: true });
// Discover new public components from source so release exports cannot silently lag.
const barrel = reactNames.map(name => name === 'sonner'
  ? 'export { SonnerToaster, toast as sonnerToast } from "./components/ui/sonner.js";\nexport type { ToasterProps as SonnerToasterProps } from "./components/ui/sonner.js";'
  : `export * from "./components/ui/${name}.js";`).join('\n')
  + '\n' + hooks.map(name => `export * from "./hooks/${name}.js";`).join('\n')
  + '\nexport { cn } from "./lib/utils.js";\n';
await writeFile(join(root, 'src/index.ts'), '"use client";\n\n' + barrel);
execFileSync('pnpm', ['exec', 'tsc'], { cwd: root, stdio: 'inherit' });
await cp(join(root, 'src/astro'), join(root, 'dist/astro'), {
  recursive: true,
  filter: source => !/\.(?:stories|test|spec)\./.test(source),
});
await writeFile(join(root, 'dist/index.js'), '"use client";\n\n' + barrel.replace(/^export type .*\n/gm, ''));
await writeFile(join(root, 'dist/index.d.ts'), barrel);
// The generated barrels have no source file to map back to.
await Promise.all(['index.js.map', 'index.d.ts.map'].map(name => rm(join(root, 'dist', name), { force: true })));

for (const name of ['styles', 'components']) {
  execFileSync('pnpm', ['exec', 'tailwindcss', '-i', `src/styles/${name}.css`, '-o', `dist/${name}.css`, '--minify'], {
    cwd: root, stdio: 'inherit',
  });
}

manifest.exports = rootExports(reactNames, astroNames, hooks);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await buildRendererPackages(root, manifest, reactNames, astroNames, hooks);
