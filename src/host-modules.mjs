/**
 * Locate the dsh packages this plugin shares with its host.
 *
 * A `link:`-installed plugin resolves bare specifiers from its own real path,
 * not from the profile that activated it, so `import '@deepseek-ai/dsh-session'`
 * fails even though the host has it loaded. Every lookup therefore:
 *
 *   1. tries the bare specifier (a normally installed plugin);
 *   2. tries `DSH_MODULE_ROOT` / `config.moduleRoot`;
 *   3. walks the profile `node_modules` and the global dsh install.
 *
 * Nothing is bundled: the plugin must use the *host's* session implementation,
 * otherwise event ids and projections would come from a second copy.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const cache = new Map();

function home() {
  return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh');
}

function globalRoots() {
  const appData = process.env.APPDATA ?? '';
  const roots = [];
  if (appData) {
    roots.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'));
    roots.push(join(appData, 'npm', 'node_modules'));
  }
  roots.push(join(process.execPath, '..', 'node_modules'));
  return roots;
}

async function profileRoots() {
  const profiles = join(home(), 'profiles');
  let names;
  try {
    names = await readdir(profiles);
  } catch {
    return [];
  }
  return names.map((name) => join(profiles, name, 'node_modules'));
}

/** Every directory a host package may live in, most specific first. */
export async function moduleRoots({ moduleRoot } = {}) {
  const roots = [];
  if (moduleRoot) roots.push(moduleRoot);
  if (process.env.DSH_MODULE_ROOT) roots.push(process.env.DSH_MODULE_ROOT);
  roots.push(...(await profileRoots()), ...globalRoots());
  return roots;
}

/** Resolve one package directory, or undefined when no candidate has it. */
export async function findPackage(name, options = {}) {
  for (const root of await moduleRoots(options)) {
    const directory = join(root, ...name.split('/'));
    if (existsSync(join(directory, 'package.json'))) return directory;
  }
  return undefined;
}

async function importPackage(name, options = {}) {
  const key = `${name}\u0000${options.moduleRoot ?? ''}`;
  if (cache.has(key)) return cache.get(key);
  const pending = (async () => {
    try {
      return await import(name);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    const directory = await findPackage(name, options);
    if (!directory) return undefined;
    return import(pathToFileURL(join(directory, 'lib', 'index.js')).href);
  })();
  cache.set(key, pending);
  return pending;
}

/**
 * The host session implementation.
 *
 * Returns `undefined` when the host does not expose it; callers degrade to
 * chat-only undo rather than failing the whole plugin activation.
 */
export async function loadSessionModule(options) {
  return importPackage('@deepseek-ai/dsh-session', options);
}

/** The format catalog used to reject a corrupt replay before it is appended. */
export async function loadFormatCatalog(options) {
  return importPackage('@deepseek-ai/dsh-session-format-catalog', options);
}

/** Test seam: forget every resolved module. */
export function resetModuleCache() {
  cache.clear();
}
