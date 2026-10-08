#!/usr/bin/env node
/**
 * Read-only architecture gate. Uses TypeScript's parser/resolver, never executes
 * application code. Ownership is checked on resolved real paths, not spelling.
 * Tests/tooling compose products outside this production graph; importing one
 * of those excluded files from production is still an error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const normalize = (value) => value.split(path.sep).join('/');
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compare complete identifier words, including configured multiword brands.
// A product named Sign must not match Signal or Signing; Invoice still matches
// InvoiceDocument, INVOICE_NUMBER, and configuredInvoice.
const conceptWords = (value) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  .split(/[^a-zA-Z0-9]+/).filter(Boolean);
const identifierConcept = (text, name) => {
  const words = conceptWords(text);
  const marker = conceptWords(name);
  return marker.length > 0 && words.some((_, start) => marker.every((word, offset) =>
    words[start + offset] === word));
};
const cryptoSignMember = (node) => ts.isIdentifier(node) && node.text === 'sign'
  && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
  && ['crypto', 'crypto.subtle'].includes(node.parent.expression.getText());
const joseAdmissionJwtImport = (node) => ts.isIdentifier(node) && node.text === 'SignJWT'
  && ts.isImportSpecifier(node.parent) && node.parent.propertyName === node
  && node.parent.name.text === 'AdmissionJwt'
  && ts.isNamedImports(node.parent.parent)
  && ts.isImportClause(node.parent.parent.parent)
  && ts.isImportDeclaration(node.parent.parent.parent.parent)
  && ts.isStringLiteral(node.parent.parent.parent.parent.moduleSpecifier)
  && node.parent.parent.parent.parent.moduleSpecifier.text === 'jose';

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = (file) => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
const inside = (directory, file) => file === directory || file.startsWith(`${directory}${path.sep}`);

export function matchesGlob(value, glob) {
  let expression = '^';
  for (let i = 0; i < glob.length; i++) {
    const character = glob[i];
    if (character === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { expression += '(?:.*/)?'; i++; }
      else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${expression}$`).test(value);
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    // Symlinked source files cannot hide a different owner's implementation.
    if (entry.isDirectory()) files.push(...walk(file));
    else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(canonical(file));
  }
  return files;
}

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function exportedTargets(exports, subpath, runtime) {
  if (exports === undefined) return [];
  let selected = exports;
  let capture;
  if (typeof exports === 'object' && exports !== null && !Array.isArray(exports)
    && Object.keys(exports).some((key) => key.startsWith('.'))) {
    selected = exports[subpath];
    if (selected === undefined) {
      const patterns = Object.keys(exports).filter((key) => key.includes('*')).sort((a, b) => b.length - a.length);
      for (const pattern of patterns) {
        const [prefix, suffix = ''] = pattern.split('*');
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
          capture = subpath.slice(prefix.length, subpath.length - suffix.length || undefined);
          selected = exports[pattern]; break;
        }
      }
    }
  } else if (subpath !== '.') return [];
  const choose = (value) => {
    if (typeof value === 'string') return [capture === undefined ? value : value.replaceAll('*', capture)];
    if (Array.isArray(value)) return value.flatMap(choose);
    if (!value || typeof value !== 'object') return [];
    const conditions = runtime ? ['browser', 'import', 'require', 'default', 'types'] : ['types', 'import', 'default', 'require'];
    for (const condition of conditions) if (Object.hasOwn(value, condition)) return choose(value[condition]);
    return [];
  };
  return choose(selected);
}

function importReferences(source) {
  const references = [];
  const add = (node, argument, typeOnly = false) => {
    const literal = argument && (ts.isStringLiteralLike(argument));
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    references.push({ specifier: literal ? argument.text : null, typeOnly, line: position.line + 1, column: position.character + 1 });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly || Boolean(clause && !clause.name && clause.namedBindings
        && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length
        && clause.namedBindings.elements.every((item) => item.isTypeOnly));
      add(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly = node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length && node.exportClause.elements.every((item) => item.isTypeOnly));
      add(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'require' && node.expression.name.text === 'resolve'))) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function validateConfig(config) {
  if (config.version !== 1) throw new Error('architecture configuration requires version 1');
  for (const field of ['sourceRoots', 'workspaceRoots', 'browserEntries', 'serverOnly', 'forbiddenProductDependencies', 'forbiddenProductSurfaces', 'sharedAssets']) {
    if (!Array.isArray(config[field]) || !config[field].every((value) => typeof value === 'string')) throw new Error(`${field} must be a string array`);
  }
  for (const field of ['exclusions', 'moduleOwnership', 'boundaryExceptions', 'productConceptExceptions']) {
    if (!Array.isArray(config[field])) throw new Error(`${field} must be an array`);
    for (const exception of config[field]) if (!exception.reason?.trim()) throw new Error(`${field} entries require a reviewable reason`);
  }
  if (!Array.isArray(config.productConcepts)) throw new Error('productConcepts must be an array');
  if (!config.publicCompanions || !Array.isArray(config.publicCompanions.forbiddenBindings)
    || !Array.isArray(config.publicCompanions.forbiddenVars) || !Array.isArray(config.publicCompanions.forbiddenManifestFields))
    throw new Error('publicCompanions requires forbiddenBindings, forbiddenVars, and forbiddenManifestFields');
  for (const concept of config.productConcepts) if (!concept.product || !Array.isArray(concept.identifiers) || !Array.isArray(concept.strings))
    throw new Error('productConcepts require product, identifiers, and strings');
  for (const ownership of config.moduleOwnership) if (!ownership.product || !ownership.pattern
    || (ownership.kind !== undefined && !['product', 'product-contract'].includes(ownership.kind)))
    throw new Error('moduleOwnership requires pattern/product and product or product-contract kind');
  const boundaryKeys = new Set();
  for (const exception of config.boundaryExceptions) {
    if (!exception.from || !exception.to || !exception.rule || !Number.isSafeInteger(exception.count) || exception.count < 1)
      throw new Error('boundary exceptions require exact from/to/rule and a positive count');
    if ([exception.from, exception.to].some((value) => /[?*]/.test(value))) throw new Error('boundary exceptions cannot use wildcards');
    const key = `${exception.rule}:${exception.from}:${exception.to}`;
    if (boundaryKeys.has(key)) throw new Error(`duplicate boundary exception ${key}`);
    boundaryKeys.add(key);
  }
  for (const exception of config.productConceptExceptions) {
    if (!exception.file || !exception.product || !Array.isArray(exception.matches) || /[?*]/.test(exception.file))
      throw new Error('product concept exceptions require exact file/product/matches');
    for (const match of exception.matches) if (typeof match.text !== 'string' || !Number.isSafeInteger(match.count) || match.count < 1)
      throw new Error('product concept matches require exact text and a positive count');
  }
}

/** Returns diagnostics and the resolved graph; never modifies the workspace. */
export function checkArchitecture({ root = ROOT, config: suppliedConfig, configPath } = {}) {
  root = canonical(root);
  const config = suppliedConfig ?? readJSON(configPath ?? path.join(root, 'architecture.config.json'));
  validateConfig(config);
  const relative = (file) => normalize(path.relative(root, file));
  const violations = [];
  const diagnosticKeys = new Set();
  const report = (rule, file, message, details = {}) => {
    const diagnostic = { rule, file: relative(file), ...details, message };
    const key = JSON.stringify(diagnostic);
    if (!diagnosticKeys.has(key)) { diagnosticKeys.add(key); violations.push(diagnostic); }
  };
  const packages = [];
  for (const workspaceRoot of config.workspaceRoots) {
    const directory = path.join(root, workspaceRoot);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const packageRoot = canonical(path.join(directory, entry.name));
      const packageFile = path.join(packageRoot, 'package.json');
      if (!fs.existsSync(packageFile)) continue;
      const manifest = readJSON(packageFile);
      if (!manifest.name) throw new Error(`${relative(packageFile)} has no package name`);
      packages.push({ name: manifest.name, root: packageRoot, manifest,
        kind: workspaceRoot === 'apps' ? (entry.name === 'core' ? 'core' : 'product') : workspaceRoot === 'packages' ? 'platform' : 'vendor',
        product: workspaceRoot === 'apps' && entry.name !== 'core' ? entry.name : undefined });
    }
  }
  const byName = new Map();
  for (const owner of packages) {
    if (byName.has(owner.name)) throw new Error(`duplicate workspace package ${owner.name}`);
    byName.set(owner.name, owner);
  }
  // Public recipients enter a separate, app-owned companion. They do not
  // inherit private installation identity, Core data, or signing authority.
  const corePackage = packages.find((owner) => owner.kind === 'core');
  const coreConfigFile = corePackage && path.join(corePackage.root, 'wrangler.json');
  const coreConfig = coreConfigFile && fs.existsSync(coreConfigFile) ? readJSON(coreConfigFile) : {};
  const installationFile = path.join(root, 'open-cloud.config.json');
  const installation = fs.existsSync(installationFile) ? readJSON(installationFile) : {};
  const coreDatabases = new Set((coreConfig.d1_databases ?? []).map((item) => item.database_name).filter(Boolean));
  const coreBuckets = new Set((coreConfig.r2_buckets ?? []).map((item) => item.bucket_name).filter(Boolean));
  if (installation.name) { coreDatabases.add(`${installation.name}-catalog`); coreBuckets.add(`${installation.name}-files`); }
  const coreDatabaseId = installation.storage?.catalogDatabaseId;
  for (const owner of packages.filter((item) => item.kind === 'product')) {
    const manifestFile = path.join(owner.root, 'app.manifest.json');
    if (fs.existsSync(manifestFile)) {
      const manifest = readJSON(manifestFile);
      for (const field of config.publicCompanions.forbiddenManifestFields) if (Object.hasOwn(manifest, field))
        report('whole-app-public-setting', manifestFile, `Manifest field ${field} is forbidden; public recipient routes belong to a separate narrow companion`);
    }
    const publicFile = path.join(owner.root, 'public.wrangler.json');
    if (!fs.existsSync(publicFile)) continue;
    const companion = readJSON(publicFile);
    const privateFile = path.join(owner.root, 'wrangler.json');
    const privateConfig = fs.existsSync(privateFile) ? readJSON(privateFile) : {};
    if (companion.services?.length) report('public-outbound-service', publicFile,
      'Public companions cannot declare outbound services; tooling generates only the local app data proxy');
    for (const field of config.publicCompanions.forbiddenVars) if (Object.hasOwn(companion.vars ?? {}, field))
      report('public-core-context', publicFile, `Public companion cannot configure Core authority variable ${field}`);
    const bindings = [...(companion.d1_databases ?? []), ...(companion.r2_buckets ?? []), ...(companion.kv_namespaces ?? []), ...(companion.durable_objects?.bindings ?? [])];
    for (const binding of bindings) {
      const name = binding.binding ?? binding.name;
      if (config.publicCompanions.forbiddenBindings.includes(name)) report('public-core-binding', publicFile, `Public companion cannot bind Core resource ${name}`);
      if ((binding.database_name && coreDatabases.has(binding.database_name)) || (binding.bucket_name && coreBuckets.has(binding.bucket_name))
        || (coreDatabaseId && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(coreDatabaseId) && binding.database_id === coreDatabaseId))
        report('public-core-storage', publicFile, 'Public companion cannot alias Core catalog or workspace file storage');
      if (binding.script_name && [coreConfig.name, installation.name && `${installation.name}-core`].filter(Boolean).includes(binding.script_name))
        report('public-core-binding', publicFile, 'Public companion cannot bind a Core Durable Object through an alias');
    }
    if (typeof companion.main === 'string' && typeof privateConfig.main === 'string'
      && canonical(path.resolve(owner.root, companion.main)) === canonical(path.resolve(owner.root, privateConfig.main)))
      report('public-private-entrypoint', publicFile, 'Public companion must use a separate recipient entrypoint, not expose the private application Worker');
  }
  const physicalOwner = (file) => packages.filter((owner) => inside(owner.root, file)).sort((a, b) => b.root.length - a.root.length)[0];
  const ownerOf = (file) => {
    const physical = physicalOwner(file);
    const overrides = config.moduleOwnership.filter((entry) => matchesGlob(relative(file), entry.pattern));
    if (overrides.length > 1) throw new Error(`ambiguous module ownership for ${relative(file)}`);
    return overrides.length ? { ...physical, kind: overrides[0].kind ?? 'product', product: overrides[0].product } : physical;
  };
  const excluded = (file) => config.exclusions.find((entry) => matchesGlob(relative(file), entry.pattern));
  const files = [...new Set(config.sourceRoots.flatMap((directory) => walk(path.join(root, directory))))].filter((file) => !excluded(file)).sort();
  const sourceFiles = new Set(files);
  const tsconfig = path.join(root, 'tsconfig.json');
  let compilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, resolveJsonModule: true, allowJs: true };
  if (fs.existsSync(tsconfig)) {
    const loaded = ts.readConfigFile(tsconfig, ts.sys.readFile);
    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
    const configurationErrors = parsed.errors.filter((error) => error.code !== 18003);
    if (configurationErrors.length) throw new Error(configurationErrors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    compilerOptions = { ...compilerOptions, ...parsed.options };
  }
  const moduleCache = ts.createModuleResolutionCache(root, (value) => value, compilerOptions);
  const resolveTS = (specifier, file) => {
    const found = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys, moduleCache).resolvedModule?.resolvedFileName;
    return found && canonical(found);
  };
  const resolve = (specifier, file, runtime) => {
    const owner = byName.get(packageName(specifier));
    if (owner) {
      const subpath = specifier === owner.name ? '.' : `.${specifier.slice(owner.name.length)}`;
      const targets = exportedTargets(owner.manifest.exports, subpath, runtime);
      for (const target of targets) {
        if (!target.startsWith('./')) continue;
        const absolute = path.resolve(owner.root, target);
        const resolved = resolveTS(absolute, file) ?? (fs.existsSync(absolute) ? canonical(absolute) : undefined);
        if (resolved) return { file: resolved, owner, public: true };
      }
      const privateTarget = subpath === '.' ? owner.manifest.main ?? './src/index.ts' : subpath;
      return { owner, public: false, file: resolveTS(specifier, file) ?? resolveTS(path.resolve(owner.root, privateTarget), file) };
    }
    let resolved = resolveTS(specifier, file);
    if (!resolved && (specifier.startsWith('.') || path.isAbsolute(specifier))) {
      const asset = path.resolve(path.dirname(file), specifier);
      if (/\.(?:json|css|svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$/.test(asset) && fs.existsSync(asset)) resolved = canonical(asset);
    }
    return { file: resolved };
  };
  const exceptionUses = new Map();
  const boundary = (rule, from, to, edge, message) => {
    const key = `${rule}:${relative(from)}:${relative(to)}`;
    const exception = config.boundaryExceptions.find((entry) => entry.rule === rule && entry.from === relative(from) && entry.to === relative(to));
    if (exception) {
      const count = (exceptionUses.get(key) ?? 0) + 1;
      exceptionUses.set(key, count);
      if (count <= exception.count) return;
    }
    report(rule, from, message, { target: relative(to), line: edge.line, specifier: edge.specifier });
  };
  for (const owner of packages) {
    const logicalOwner = ownerOf(path.join(owner.root, 'src/index.ts'));
    for (const dependency of Object.keys({ ...owner.manifest.dependencies, ...owner.manifest.optionalDependencies, ...owner.manifest.devDependencies, ...owner.manifest.peerDependencies })) {
      const target = byName.get(dependency);
      if (['product', 'product-contract'].includes(logicalOwner?.kind)
        && (target?.kind === 'product' || target?.kind === 'core' || config.forbiddenProductDependencies.includes(dependency)))
        report('forbidden-product-dependency', path.join(owner.root, 'package.json'), `${owner.name} may not declare dependency ${dependency}`);
      if (['platform', 'core'].includes(logicalOwner?.kind) && target?.kind === 'product')
        report('forbidden-platform-dependency', path.join(owner.root, 'package.json'), `${owner.name} may not declare product implementation dependency ${dependency}`);
    }
  }
  const edges = [];
  const concepts = [];
  const productIds = [...new Set([...packages.filter((owner) => owner.kind === 'product').map((owner) => owner.product), ...config.productConcepts.map((item) => item.product)])];
  for (const file of files) {
    const owner = physicalOwner(file);
    const logicalOwner = ownerOf(file);
    if (!owner) { report('unowned-source', file, 'Production source must belong to a workspace package'); continue; }
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const error of source.parseDiagnostics) report('source-parse-error', file, ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    for (const reference of importReferences(source)) {
      if (reference.specifier === null) { report('nonliteral-import', file, 'Dynamic imports and require calls must use a literal so ownership can be checked', reference); continue; }
      const specifier = reference.specifier;
      const builtin = isBuiltin(specifier) || specifier === 'cloudflare:workers'; // Exact server runtime builtin alongside Node builtins without broad scheme exemptions
      const found = builtin ? {} : resolve(specifier, file, !reference.typeOnly);
      const target = found.file;
      const targetPhysical = target ? physicalOwner(target) : found.owner;
      const targetOwner = target ? ownerOf(target) : found.owner;
      const namedDependency = !specifier.startsWith('.') && !path.isAbsolute(specifier) && !builtin ? packageName(specifier) : undefined;
      const declaredName = targetPhysical ? (targetPhysical.name !== owner.name ? targetPhysical.name : undefined) : namedDependency;
      const declared = { ...owner.manifest.dependencies, ...owner.manifest.optionalDependencies, ...owner.manifest.peerDependencies,
        ...(reference.typeOnly ? owner.manifest.devDependencies : {}) };
      if (declaredName && declaredName !== owner.name && !Object.hasOwn(declared, declaredName))
        report('undeclared-dependency', file, `${owner.name} must declare ${declaredName}`, reference);
      if (found.owner && !found.public) report('private-package-surface', file, `No resolvable public export for ${specifier}`, reference);
      if (!target && !builtin && (specifier.startsWith('.') || path.isAbsolute(specifier) || found.owner || (compilerOptions.paths && Object.keys(compilerOptions.paths).some((pattern) => matchesGlob(specifier, pattern)))))
        report('unresolved-import', file, `Cannot resolve ${specifier}`, reference);
      if (target && excluded(target)) report('production-composition-import', file, `Production may not import excluded composition file ${relative(target)}`, reference);
      if (target && inside(root, target) && !inside(path.join(root, 'node_modules'), target) && !targetPhysical && !excluded(target)
        && !config.sharedAssets.some((pattern) => matchesGlob(relative(target), pattern)))
        report('unowned-import', file, `Production import ${relative(target)} has no package owner or shared-asset declaration`, reference);
      if (target && targetPhysical && targetPhysical.kind !== 'vendor' && SOURCE.test(target) && !target.endsWith('.d.ts')
        && !sourceFiles.has(target) && !excluded(target))
        report('unscanned-source-import', file, `Production import ${relative(target)} is outside the checked source graph`, reference);
      if (targetPhysical && targetPhysical.name !== owner.name && !found.owner) {
        // Even an alias to a public file must use its package export; relative
        // imports into workspace implementation are never an API contract.
        boundary('private-package-surface', file, target, reference, `Cross-package imports must use the declared public export of ${targetPhysical.name}`);
      }
      if (['product', 'product-contract'].includes(logicalOwner?.kind) && (targetOwner?.kind === 'core'
        || (targetOwner?.kind === 'product' && targetOwner.product !== logicalOwner.product)
        || (logicalOwner.kind === 'product-contract' && targetOwner?.kind === 'product')))
        boundary('product-isolation', file, target ?? found.owner.root, reference, `${logicalOwner.product} may not import ${targetOwner.product ?? 'Core'} implementation`);
      if (['platform', 'core'].includes(logicalOwner?.kind) && ['product', 'product-contract'].includes(targetOwner?.kind))
        boundary('platform-product-import', file, target ?? found.owner.root, reference, 'Core and generic platform modules may not import product implementations');
      if (['product', 'product-contract'].includes(logicalOwner?.kind) && (config.forbiddenProductDependencies.includes(targetPhysical?.name)
        || config.forbiddenProductSurfaces.includes(specifier)))
        boundary('product-private-platform', file, target ?? found.owner?.root ?? file, reference, 'Products must use Core contracts/client adapters rather than Core-owned server implementation');
      edges.push({ from: file, to: target, specifier, typeOnly: reference.typeOnly, builtin, line: reference.line });
    }
    if (['platform', 'core'].includes(logicalOwner?.kind)) {
      const counts = new Map();
      const visit = (node) => {
        if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
          const text = node.text;
          for (const product of productIds) {
            const pascal = product.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
            const upper = product.replaceAll('-', '_').toUpperCase();
            const names = config.productConcepts.find((item) => item.product === product);
            const special = product === 'forms' && (text.includes('FormDraft') || text.includes('application/vnd.open-cloud.form+json'));
            // OAuth's lowercase decision value "approve" is a generic verb,
            // not the Approve product. Namespaced actions/brand/model names are
            // still checked, without baselining ordinary consent decisions.
            const markers = [pascal, upper, ...(names?.identifiers ?? [])];
            const genericSign = product === 'sign' && (cryptoSignMember(node)
              || joseAdmissionJwtImport(node)
              || (ts.isStringLiteralLike(node) && text === 'sign'));
            // Authentication prose uses “sign in” and “sign-in”. Exempt only
            // those exact phrases; branded names and action namespaces remain.
            const prose = product === 'sign' && ts.isStringLiteralLike(node)
              ? text.replace(/\bsign(?:-in| in)\b/gi, '') : text;
            const identified = !genericSign && (ts.isIdentifier(node)
              ? (markers.some((name) => identifierConcept(text, name))
                || [product, ...(names?.strings ?? [])].some((name) =>
                  new RegExp(`(?:^|_)${escapePattern(name)}_`).test(text)))
              : !(product === 'approve' && text === 'approve')
                && ([product, ...(names?.strings ?? [])].some((name) =>
                  new RegExp(`(?:^|[^a-z0-9])${escapePattern(name)}(?:$|[^a-z0-9])`, 'i').test(prose))
                  || markers.some((name) => identifierConcept(prose, name))));
            if (special || identified) {
              const key = JSON.stringify([product, text]);
              counts.set(key, (counts.get(key) ?? 0) + 1);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const [key, count] of counts) { const [product, text] = JSON.parse(key); concepts.push({ file: relative(file), product, text, count }); }
    }
  }
  for (const exception of config.boundaryExceptions) {
    const key = `${exception.rule}:${exception.from}:${exception.to}`;
    if ((exceptionUses.get(key) ?? 0) !== exception.count)
      report('stale-boundary-exception', path.join(root, exception.from), `Exception for ${exception.to} expected ${exception.count} uses; found ${exceptionUses.get(key) ?? 0}`);
  }
  const expectedConcepts = new Map();
  for (const exception of config.productConceptExceptions) for (const match of exception.matches) {
    const key = JSON.stringify([exception.file, exception.product, match.text]);
    if (expectedConcepts.has(key)) throw new Error(`duplicate product concept exception ${key}`);
    expectedConcepts.set(key, match.count);
  }
  for (const concept of concepts) {
    const key = JSON.stringify([concept.file, concept.product, concept.text]);
    const expected = expectedConcepts.get(key) ?? 0;
    if (concept.count !== expected) report(expected > concept.count ? 'stale-product-concept-exception' : 'platform-product-concept', path.join(root, concept.file),
      `Product ${concept.product} concept ${JSON.stringify(concept.text)} occurs ${concept.count} times; reviewed baseline is ${expected}`);
    expectedConcepts.delete(key);
  }
  for (const [key] of expectedConcepts) { const [file, product, text] = JSON.parse(key);
    report('stale-product-concept-exception', path.join(root, file), `Remove stale ${product} exception for ${JSON.stringify(text)}`); }

  // Runtime closure: a browser barrel cannot conceal a server-only dependency.
  const adjacency = new Map();
  for (const edge of edges.filter((edge) => !edge.typeOnly)) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
  }
  const browserEntries = files.filter((file) => ownerOf(file)?.kind === 'product-contract'
    || config.browserEntries.some((pattern) => matchesGlob(relative(file), pattern)));
  const serverOnly = (file) => config.serverOnly.some((pattern) => matchesGlob(relative(file), pattern));
  for (const entry of browserEntries) {
    const queue = [{ file: entry, chain: [relative(entry)] }];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current.file)) continue;
      visited.add(current.file);
      for (const edge of adjacency.get(current.file) ?? []) {
        const chain = [...current.chain, edge.to ? relative(edge.to) : edge.specifier];
        if (edge.builtin || (edge.to && serverOnly(edge.to)) || config.serverOnly.some((pattern) => matchesGlob(edge.specifier, pattern)
          || matchesGlob(packageName(edge.specifier), pattern)))
          report('browser-server-leak', current.file, `Browser runtime reaches server-only module: ${chain.join(' -> ')}`, { line: edge.line, specifier: edge.specifier, entry: relative(entry) });
        else if (edge.to && sourceFiles.has(edge.to)) queue.push({ file: edge.to, chain });
      }
    }
  }
  // Declared workspace dependencies and resolved imports both form edges. A
  // cycle through type-only imports is still an architectural package cycle.
  const packageGraph = new Map(packages.map((owner) => [owner.name, new Set()]));
  for (const owner of packages) for (const name of Object.keys({ ...owner.manifest.dependencies, ...owner.manifest.optionalDependencies, ...owner.manifest.peerDependencies }))
    if (byName.has(name) && name !== owner.name) packageGraph.get(owner.name).add(name);
  for (const edge of edges) {
    const from = physicalOwner(edge.from)?.name, to = edge.to && physicalOwner(edge.to)?.name;
    if (from && to && from !== to) packageGraph.get(from).add(to);
  }
  const done = new Set(), active = [];
  const cycleVisit = (name) => {
    if (active.includes(name)) {
      const cycle = [...active.slice(active.indexOf(name)), name];
      report('package-cycle', path.join(byName.get(name).root, 'package.json'), cycle.join(' -> ')); return;
    }
    if (done.has(name)) return;
    active.push(name);
    for (const dependency of [...packageGraph.get(name)].sort()) cycleVisit(dependency);
    active.pop(); done.add(name);
  };
  for (const name of [...packageGraph.keys()].sort()) cycleVisit(name);
  violations.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
  return { ok: violations.length === 0, violations, files: files.map(relative), edges: edges.map((edge) => ({ ...edge, from: relative(edge.from), to: edge.to && relative(edge.to) })), packages: packages.map((owner) => owner.name), concepts };
}

function main(args) {
  let root = ROOT, configPath, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i]);
    else if (args[i] === '--config' && args[i + 1]) configPath = path.resolve(args[++i]);
    else if (args[i] === '--json') json = true;
    else throw new Error(`Usage: node scripts/check-architecture.mjs [--root path] [--config path] [--json]; unknown argument ${args[i]}`);
  }
  const result = checkArchitecture({ root, configPath });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`Architecture passed: ${result.files.length} production files, ${result.packages.length} workspace packages.`);
  else for (const item of result.violations) console.error(`${item.file}${item.line ? `:${item.line}` : ''} [${item.rule}] ${item.message}`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Architecture configuration error: ${error.message}`); process.exitCode = 1; }
}
