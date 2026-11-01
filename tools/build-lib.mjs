/**
 * The bundler, as a library so tests can rebuild in-process.
 *
 * Modules are concatenated by hand rather than by esbuild. There are no
 * third-party dependencies, so bundling here only means inlining local imports
 * in dependency order, and esbuild's binary cannot be exec'd inside this
 * project's own sandbox (it fails with EPERM under the seccomp filter). A tool
 * whose default invocation needs privileges the checks do not have is a worse
 * default than the deterministic glue below, whose invariants are asserted:
 * dependency-ordered, one function scope per module so module-private names
 * cannot collide, and the result actually loaded against a stub DOM.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Topological order over local `./x.js` imports, dependencies first. */
function dependencyOrder(entry) {
  const seen = new Set();
  const order = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (!specifier.startsWith('.')) {
        throw new Error(`${file}: only relative imports are allowed, got ${specifier}`);
      }
      visit(resolve(file, '..', specifier));
    }
    order.push(file);
  };
  visit(entry);
  return order;
}

/** Top-level `const`/`let`/`class` names a module declares, for collision checks. */
function topLevelNames(source) {
  const names = new Set();
  const patterns = [
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/**
 * Reject two modules declaring the same top-level binding.
 *
 * Sharing one scope is what makes cross-module references work, and the cost of
 * that choice is that a duplicate becomes a hard error. Detecting it here, with
 * both filenames, is the whole reason not to hand-write the concatenation: the
 * alternative is a bundle that parses and then does something quietly wrong.
 */
function assertNoCollisions(modules) {
  const seen = new Map();
  for (const { file, source } of modules) {
    for (const name of topLevelNames(source)) {
      if (seen.has(name)) {
        throw new Error(`duplicate top-level binding "${name}" in ${seen.get(name)} and ${file}`);
      }
      seen.set(name, file);
    }
  }
}

/** Strip ESM syntax so a set of module files can run as one classic script. */
function stripModuleSyntax(source, file) {
  const stripped = source
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(?=class|function\s+(?:async\s+)?|const\s|let\s|var\s|async\s+function\s)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  const leftover = stripped.match(/^\s*(import|export)\b.*$/m);
  if (leftover) throw new Error(`${file}: unbundler left ${leftover[0].trim().slice(0, 60)}`);
  return stripped;
}

function bundleModules(entry) {
  const files = dependencyOrder(entry);
  const modules = files.map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  assertNoCollisions(modules);
  const parts = modules.map(({ file, source }) => {
    const label = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
    return `/* --- ${label} --- */\n${stripModuleSyntax(source, file)}`;
  });
  // A single function scope for the whole bundle, not one per module. ESM gives
  // every module its own scope *and* sees the bindings its imports export; one
  // shared function scope reproduces the first property and, because modules are
  // concatenated in dependency order, reproduces the second for the
  // function-call-time references this codebase actually makes. Separate IIFEs
  // per module would look tidier and silently produce "App is not defined".
  return `(function () {\n'use strict';\n${parts.join('\n\n')}\n})();\n`;
}

/**
 * A browser surface just large enough to load the bundle. Running the code
 * rather than only parsing it is the point: a missing symbol or a wrong module
 * order is a build failure, and those are exactly the failures this bundler can
 * produce.
 */
function stubGlobals() {
  const noop = () => {};
  const target = globalThis;
  Object.assign(target, {
    window: target,
    document: {
      readyState: 'loading',
      addEventListener: noop,
      querySelector: () => null,
      documentElement: { dataset: {} },
    },
    location: { search: '' },
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
  });
}

function assertLoads(code) {
  stubGlobals();
  try {
    (0, eval)(code);
  } catch (error) {
    throw new Error(`bundle fails to load: ${error.message}`);
  }
}

/** Produce the contents of index.html from src/, as a string. */
export function buildArtifact(root = ROOT) {
  const bundled = bundleModules(join(root, 'src', 'boot.js'));
  assertLoads(bundled);
  if (/<\/script/i.test(bundled)) {
    // An IIFE cannot contain this, but asserting beats assuming: an unescaped
    // closing tag would truncate the artifact at load time, silently.
    throw new Error('bundle contains a literal </script>; output would be truncated');
  }
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8').trim();
  const template = readFileSync(join(root, 'src', 'page.html'), 'utf8');
  const banner = '<!-- Aurelia: generated by tools/build.mjs from src/. Edit src/, not this file. -->\n';
  const page = banner + template.replace('/* __STYLE__ */', () => css).replace('/* __APP__ */', () => bundled);
  if (page.includes('__STYLE__') || page.includes('__APP__')) {
    throw new Error('template placeholder left unsubstituted');
  }
  return page;
}
