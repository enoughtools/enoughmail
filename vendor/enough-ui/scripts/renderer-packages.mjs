import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const kebabCase = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
const publicFile = name => !name.startsWith('_') && !/\.(?:stories|test|spec)\./.test(name);

export async function componentNames(root) {
  return (await readdir(join(root, 'src/components/ui')))
    .filter(name => publicFile(name) && /\.(?:ts|tsx)$/.test(name) && !name.endsWith('.d.ts'))
    .map(name => name.replace(/\.tsx?$/, '')).sort();
}

export async function astroComponentNames(root) {
  return (await readdir(join(root, 'src/astro')))
    .filter(name => publicFile(name) && name.endsWith('.astro'))
    .map(name => name.slice(0, -6)).sort();
}

export async function hookNames(root) {
  return (await readdir(join(root, 'src/hooks')))
    .filter(name => publicFile(name) && /\.(?:ts|tsx)$/.test(name) && !name.endsWith('.d.ts'))
    .map(name => name.replace(/\.tsx?$/, '')).sort();
}

const jsExport = file => ({ types: `./dist/${file}.d.ts`, import: `./dist/${file}.js` });

// Package READMEs live outside the repository tree. Resolve repository artwork
// and documentation against the matching release without packing catalog assets.
export function packageReadme(source, version) {
  const ref = `v${encodeURIComponent(version)}`;
  const repository = 'enoughtools/enough-ui';
  return source.replace(/(!?)\[([^\[\]]*)\]\(([^\s)]+)\)/g, (match, image, label, target) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) return match;
    const path = target.replace(/^\.\//, '');
    const base = image
      ? `https://raw.githubusercontent.com/${repository}/${ref}/`
      : `https://github.com/${repository}/blob/${ref}/`;
    return `${image}[${label}](${base}${path})`;
  });
}
export function reactExports(names, hooks = ['use-toast']) {
  return {
    '.': jsExport('index'),
    './styles.css': './dist/styles.css',
    './components.css': './dist/components.css',
    ...Object.fromEntries(hooks.map(name => [`./${name}`, jsExport(`hooks/${name}`)])),
    './utils': jsExport('lib/utils'),
    ...Object.fromEntries(names.map(name => [`./${name}`, jsExport(`components/ui/${name}`)])),
  };
}

export function astroExports(names) {
  return {
    '.': jsExport('index'),
    './styles.css': './dist/styles.css',
    './components.css': './dist/components.css',
    './utils': jsExport('lib/utils'),
    ...Object.fromEntries(names.map(name => [`./${kebabCase(name)}`, `./dist/astro/${name}.astro`])),
  };
}

export function rootExports(reactNames, astroNames, hooks) {
  return {
    ...reactExports(reactNames, hooks),
    ...Object.fromEntries(astroNames.map(name => [`./astro/${kebabCase(name)}`, `./dist/astro/${name}.astro`])),
  };
}

export function importsOf(source, filename) {
  // Astro frontmatter and script blocks are code; template prose is not.
  const scriptSources = [];
  if (filename.endsWith('.astro')) {
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
    const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    for (const [, attributes] of scripts) {
      const src = attributes.match(/\bsrc\s*=\s*(['"])(.*?)\1/);
      if (src) scriptSources.push(src[2]);
    }
    source = [frontmatter, ...scripts.map(([, , code]) => code)].join('\n');
  }
  return [...scriptSources, ...ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName)];
}

export function dependencyName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

// Follow emitted imports, including declaration imports, rather than copying whole folders.
export async function artifactGraph(dist, entryFiles, renderer) {
  const files = new Set();
  const dependencies = new Set();
  async function visit(name) {
    name = name.replaceAll('\\', '/');
    if (files.has(name)) return;
    if (name.startsWith('../') || name.startsWith('/') || /\.(?:stories|test|spec)\./.test(name)) {
      throw new Error(`Invalid ${renderer} artifact import: ${name}`);
    }
    if (renderer === 'astro' && !/^(?:index\.(?:js|d\.ts)|astro\/.*\.astro|lib\/.*\.(?:js|d\.ts))$/.test(name)) {
      throw new Error(`Native Astro must not include renderer-specific code: ${name}`);
    }
    if (renderer === 'react' && name.endsWith('.astro')) throw new Error(`React cannot include an Astro component: ${name}`);
    const source = await readFile(join(dist, name), 'utf8');
    files.add(name);
    for (const specifier of importsOf(source, name)) {
      if (specifier.startsWith('.')) {
        const target = relative(dist, resolve(dist, dirname(name), specifier)).replaceAll('\\', '/');
        await visit(target);
      } else {
        const dependency = dependencyName(specifier);
        if (renderer === 'astro' && /(?:^|[/-])react(?:$|[/-])/.test(dependency)) {
          throw new Error(`Native Astro cannot depend on ${dependency} (${name})`);
        }
        dependencies.add(dependency);
      }
    }
    if (name.endsWith('.js')) await visit(name.slice(0, -3) + '.d.ts');
  }
  for (const name of entryFiles) await visit(name);
  return { files: [...files].sort(), dependencies: [...dependencies].sort() };
}

export async function buildRendererPackages(root, rootManifest, reactNames, astroNames, hooks) {
  const dist = join(root, 'dist');
  for (const renderer of ['react', 'astro']) {
    const directory = join(root, 'packages', renderer);
    await mkdir(directory, { recursive: true });
    const previous = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    await rm(join(directory, 'dist'), { recursive: true, force: true });
    const entries = renderer === 'react'
      ? ['index.js', 'lib/utils.js', ...hooks.map(name => `hooks/${name}.js`), ...reactNames.map(name => `components/ui/${name}.js`)]
      : ['lib/utils.js', ...astroNames.map(name => `astro/${name}.astro`)];
    const graph = await artifactGraph(dist, entries, renderer);
    for (const file of graph.files) {
      const destination = join(directory, 'dist', file);
      await mkdir(dirname(destination), { recursive: true });
      // Source lives in the repository, not the release artifact. Do not publish dangling maps.
      const source = (await readFile(join(dist, file), 'utf8')).replace(/^\/\/[#@] sourceMappingURL=.*(?:\r?\n|$)/gm, '');
      await writeFile(destination, source);
    }
    for (const name of ['styles.css', 'components.css']) await cp(join(dist, name), join(directory, 'dist', name));
    if (renderer === 'astro') {
      const barrel = astroNames.map(name => `export { default as ${name} } from "./astro/${name}.astro";`).join('\n') + '\n';
      await writeFile(join(directory, 'dist/index.js'), barrel);
      await writeFile(join(directory, 'dist/index.d.ts'), barrel);
    }
    const peers = renderer === 'react' ? { react: '^19.0.0', 'react-dom': '^19.0.0' } : { astro: '^7.0.0' };
    const dependencies = {};
    for (const name of graph.dependencies) {
      if (name in peers) continue;
      const version = rootManifest.dependencies[name];
      if (!version) throw new Error(`${renderer} imports undeclared production dependency ${name}`);
      dependencies[name] = version;
    }
    const manifest = {
      ...previous,
      version: rootManifest.version,
      license: rootManifest.license,
      engines: rootManifest.engines,
      homepage: rootManifest.homepage,
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: renderer === 'react' ? reactExports(reactNames, hooks) : astroExports(astroNames),
      dependencies,
      peerDependencies: peers,
      ...(renderer === 'astro' ? { peerDependenciesMeta: { astro: { optional: true } } } : {}),
    };
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(directory, 'README.md'), packageReadme(await readFile(join(root, 'README.md'), 'utf8'), manifest.version));
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      try { await cp(join(root, name), join(directory, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    console.log(`${manifest.name}: ${graph.files.length} renderer files, ${Object.keys(dependencies).length} production dependencies`);
  }
}
