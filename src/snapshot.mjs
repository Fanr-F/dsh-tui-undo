import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { git, GitError } from './git.mjs';
import { workspaceKey } from './paths.mjs';

const DEFAULT_MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_PATHSPEC_ARGUMENT = process.platform === 'win32' ? 24_000 : 128 * 1024;

const REPOSITORY_CONFIG = `
[core]
	bare = false
	autocrlf = false
	longpaths = true
	symlinks = true
	fsmonitor = false
	untrackedCache = true
	splitIndex = false
	filemode = false
[feature]
	manyFiles = true
[index]
	version = 4
	threads = true
`;

export class SnapshotError extends Error {
  constructor(operation, message, cause) {
    super(message);
    this.name = 'SnapshotError';
    this.operation = operation;
    if (cause) this.cause = cause;
  }
}

/** Content-addressed store for one worktree. */
export class SnapshotService {
  #repository;

  constructor(repository) {
    this.#repository = repository;
  }

  /**
   * Open (and on first use seed) the shadow repository that mirrors `worktree`.
   *
   * `root` must live outside the worktree: the shadow repository is the one
   * directory whose contents must never be captured into a snapshot.
   */
  static async open({ worktree, root, projectId, maxUntrackedBytes = DEFAULT_MAX_UNTRACKED_BYTES, tmp = tmpdir() }) {
    const tree = await realpath(worktree);
    const store = await prepareRoot(root);
    if (inside(tree, store) || inside(store, tree)) {
      throw new SnapshotError('init', `snapshot store ${store} must not overlap the worktree ${tree}`);
    }
    const directory = join(store, projectId ?? workspaceKey(tree));
    const gitDirectory = join(directory, 'repo.git');
    const repository = {
      worktree: tree,
      gitDirectory,
      directory,
      tmp,
      maxUntrackedBytes,
    };
    await ensureRepository(repository);
    return new SnapshotService(repository);
  }

  get worktree() {
    return this.#repository.worktree;
  }

  get gitDirectory() {
    return this.#repository.gitDirectory;
  }

  /** Capture the scoped worktree as a tree object. */
  async capture({ scope = '.', maxUntrackedBytes = this.#repository.maxUntrackedBytes } = {}) {
    const scopes = pathspecFor(scope);
    const index = await this.#beginIndex();
    try {
      const untracked = await this.#list(index, ['ls-files', '--others', '--exclude-standard', '-z', '--', scopes]);
      const oversized = await this.#oversized(untracked, maxUntrackedBytes);
      // `ls-files --others` reports a collapsed directory for embedded
      // repositories and for directories that only hold ignored content.
      // Staging them either fails ("does not have a commit checked out") or
      // records a gitlink that cannot be restored, so both are excluded.
      const collapsed = (await this.#collapsed(untracked)).filter((entry) => !oversized.includes(entry.path));
      const excludes = [
        ...oversized.map((file) => `:(top,exclude,literal)${file}`),
        ...collapsed.map((entry) => `:(top,exclude,literal)${entry.path}`),
      ];
      try {
        await this.#index(index, ['add', '--all', '--', scopes, ...excludes]);
      } catch (error) {
        throw new SnapshotError('capture', `failed to stage the worktree: ${message(error)}`, error);
      }
      const embedded = await this.#dropEmbedded(index);
      for (const file of oversized) {
        await this.#index(index, ['update-index', '--force-remove', '-z', '--stdin'], `${file}\0`);
      }
      const tree = (await this.#index(index, ['write-tree'])).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(tree)) {
        throw new SnapshotError('capture', `write-tree returned an invalid object id: ${tree}`);
      }
      await this.#installIndex(index);
      return {
        tree,
        uncovered: [
          ...oversized.map((file) => ({ file, reason: 'untracked file over the size limit' })),
          ...collapsed.map((entry) => ({ file: entry.path, reason: entry.reason })),
          ...embedded.map((file) => ({ file, reason: 'embedded repository' })),
        ],
      };
    } finally {
      await rm(index, { force: true });
    }
  }

  /** Project-relative paths that differ between two captured trees. */
  async files(from, to) {
    if (from === to) return [];
    const result = await this.#run(['diff', '--no-renames', '--name-only', '-z', from, to]).catch((error) => {
      throw new SnapshotError('files', `failed to compare ${from} and ${to}: ${message(error)}`, error);
    });
    return nuls(result.stdout);
  }

  /** Structured per-file diffs between two captured trees. */
  async diff(from, to, { paths, context = 3, maxPatchBytes = DEFAULT_MAX_PATCH_BYTES } = {}) {
    if (paths?.length === 0) return [];
    if (from === to) return [];
    const base = ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-renames'];
    const pathspecs = paths?.length ? ['--', ...paths.map(literalPathspec)] : [];
    const [names, numbers, patch] = await Promise.all([
      this.#run([...base, '--name-status', '-z', from, to, ...pathspecs]),
      this.#run([...base, '--numstat', '-z', from, to, ...pathspecs]),
      this.#run(['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-ext-diff', `--unified=${context}`, '--no-renames', from, to, ...pathspecs], {
        maxOutput: maxPatchBytes,
      }),
    ]).catch((error) => {
      throw new SnapshotError('diff', `failed to diff ${from} and ${to}: ${message(error)}`, error);
    });
    const statuses = parseNameStatus(names.stdout);
    const stats = parseNumstat(numbers.stdout);
    const chunks = splitPatch(patch.stdout, statuses.map((entry) => entry.file));
    return statuses.map((entry) => {
      const stat = stats.get(entry.file);
      return {
        file: entry.file,
        status: entry.status,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
        patch: stat?.binary ? '' : (chunks.get(entry.file) ?? ''),
      };
    });
  }

  /**
   * Restore selected paths to the version recorded in their tree.
   *
   * A path that the tree does not contain is removed, mirroring opencode's
   * selective restore. A tree that cannot be read is reported and skipped: a
   * missing object must never be mistaken for "this file did not exist".
   */
  async restore(files) {
    const entries = normalizeRestoreInput(files);
    const result = { restored: [], removed: [], failed: [] };
    const groups = new Map();
    for (const entry of entries) {
      const problem = validateRelativePath(entry.file, this.#repository.worktree);
      if (problem) {
        result.failed.push({ file: entry.file, message: problem });
        continue;
      }
      if (!groups.has(entry.tree)) groups.set(entry.tree, []);
      groups.get(entry.tree).push(entry.file);
    }
    for (const [tree, group] of groups) {
      if (!(await this.#hasTree(tree))) {
        for (const file of group) result.failed.push({ file, message: `snapshot ${tree} is no longer available` });
        continue;
      }
      const batched = canBatchRestore(group);
      const present = await this.#present(tree, group);
      const checkouts = group.filter((file) => present.has(file));
      const removals = group.filter((file) => !present.has(file));
      if (checkouts.length) {
        try {
          if (batched) {
            await this.#checkoutBatch(tree, checkouts);
          } else {
            for (const file of checkouts) await this.#checkout(tree, file);
          }
          result.restored.push(...checkouts);
        } catch (error) {
          for (const file of checkouts) result.failed.push({ file, message: message(error) });
        }
      }
      for (const file of removals) {
        try {
          await rm(join(this.#repository.worktree, file), { recursive: true, force: true });
          result.removed.push(file);
        } catch (error) {
          result.failed.push({ file, message: message(error) });
        }
      }
    }
    return result;
  }

  /** List paths in `tree` that start with the given directory scope. */
  async listTree(tree, { scope = '.' } = {}) {
    const result = await this.#run(['ls-tree', '-r', '-z', '--name-only', '--full-tree', tree, '--', pathspecFor(scope)]);
    return nuls(result.stdout);
  }

  async hasTree(tree) {
    return this.#hasTree(tree);
  }

  async #hasTree(tree) {
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return false;
    try {
      await this.#run(['cat-file', '-e', `${tree}^{tree}`], { check: false });
      const probe = await this.#run(['cat-file', '-t', tree], { check: false });
      return probe.stdout.trim() === 'tree';
    } catch {
      return false;
    }
  }

  async #beginIndex() {
    const index = join(this.#repository.gitDirectory, `index.${process.pid}.${createHash('sha1').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`);
    try {
      await copyFile(join(this.#repository.gitDirectory, 'index'), index);
    } catch {
      // No index yet: an empty temporary index is the correct starting point.
    }
    return index;
  }

  async #installIndex(index) {
    await rename(index, join(this.#repository.gitDirectory, 'index'));
  }

  #index(index, args, input) {
    return this.#run(args, { index, input });
  }

  #run(args, { index, input, check = true, maxOutput } = {}) {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    env.GIT_DIR = this.#repository.gitDirectory;
    env.GIT_WORK_TREE = this.#repository.worktree;
    if (index) env.GIT_INDEX_FILE = index;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    return git(args, {
      cwd: this.#repository.worktree,
      env,
      tmp: this.#repository.tmp,
      input,
      check,
      maxOutput,
    });
  }

  async #list(index, args) {
    return nuls((await this.#index(index, args)).stdout);
  }

  async #oversized(files, limit) {
    if (!limit) return [];
    const oversized = [];
    for (const file of files) {
      try {
        const info = await stat(join(this.#repository.worktree, file));
        // `ls-files --others` also reports collapsed directory entries (embedded
        // repositories, directories of ignored files); only files carry a size.
        if (info.isFile() && info.size > limit) oversized.push(file);
      } catch {
        // Removed between listing and stat: `add` simply will not see it.
      }
    }
    return oversized;
  }

  async #collapsed(files) {
    const entries = [];
    for (const file of files) {
      if (!file.endsWith('/')) continue;
      const path = file.slice(0, -1);
      const embedded = await exists(join(this.#repository.worktree, path, '.git'));
      entries.push({ path, reason: embedded ? 'embedded repository' : 'directory of ignored files' });
    }
    return entries;
  }

  async #dropEmbedded(index) {
    const staged = await this.#index(index, ['ls-files', '--stage', '-z']);
    const embedded = [];
    for (const record of nuls(staged.stdout)) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const mode = record.slice(0, record.indexOf(' '));
      if (mode === '160000') embedded.push(record.slice(tab + 1));
    }
    if (embedded.length) {
      await this.#index(index, ['update-index', '--force-remove', '-z', '--stdin'], `${embedded.join('\0')}\0`);
    }
    return embedded;
  }

  async #present(tree, files) {
    if (files.length === 0) return new Set();
    const pathspecs = files.map(literalPathspec);
    const total = pathspecs.reduce((length, pathspec) => length + Buffer.byteLength(pathspec) + 1, 0);
    const args =
      total <= MAX_PATHSPEC_ARGUMENT
        ? ['ls-tree', '-r', '--name-only', '-z', '--full-tree', tree, '--', ...pathspecs]
        : ['ls-tree', '-r', '--name-only', '-z', '--full-tree', tree];
    const listed = new Set(nuls((await this.#run(args)).stdout));
    return new Set(files.filter((file) => listed.has(file)));
  }

  async #checkout(tree, file) {
    await this.#withTemporaryIndex(async (index) => {
      await this.#run(['checkout', tree, '--', literalPathspec(file)], { index });
    });
  }

  async #checkoutBatch(tree, files) {
    await this.#withTemporaryIndex(async (index) => {
      await this.#run(['checkout', tree, '--pathspec-from-file=-', '--pathspec-file-nul'], {
        index,
        input: `${files.map(literalPathspec).join('\0')}\0`,
      });
    });
  }

  async #withTemporaryIndex(use) {
    const index = join(this.#repository.gitDirectory, `checkout.${process.pid}.${createHash('sha1').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`);
    try {
      await copyFile(join(this.#repository.gitDirectory, 'index'), index);
    } catch {
      // Checkout works with an empty index as well.
    }
    try {
      await use(index);
    } finally {
      await rm(index, { force: true });
    }
  }
}

export function snapshotRoot(home = process.env.DSH_REWIND_HOME) {
  return home ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'rewind');
}

async function prepareRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

async function ensureRepository(repository) {
  await mkdir(repository.directory, { recursive: true, mode: 0o700 });
  if (await exists(join(repository.gitDirectory, 'HEAD'))) return;
  await git(['init', '--bare', '--quiet', repository.gitDirectory], { tmp: repository.tmp });
  await writeFile(join(repository.gitDirectory, 'config'), REPOSITORY_CONFIG, { flag: 'a' });
  const source = await discoverSource(repository);
  if (!source) return;
  await writeAlternates(repository, source);
  await seedIndex(repository, source);
}

async function discoverSource(repository) {
  try {
    const gitDirectory = (await git(['rev-parse', '--absolute-git-dir'], { cwd: repository.worktree, tmp: repository.tmp })).stdout.trim();
    const commonDirectory = await resolveCommonDirectory(repository.worktree, gitDirectory);
    return { gitDirectory, commonDirectory };
  } catch {
    return undefined;
  }
}

/** Linked worktrees keep their objects in the common directory named by `commondir`. */
async function resolveCommonDirectory(worktree, gitDirectory) {
  try {
    const content = (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim();
    return isAbsolute(content) ? content : join(gitDirectory, content);
  } catch {
    return gitDirectory;
  }
}

async function writeAlternates(repository, source) {
  const objects = join(source.commonDirectory, 'objects');
  const alternates = join(repository.gitDirectory, 'objects', 'info', 'alternates');
  await mkdir(join(repository.gitDirectory, 'objects', 'info'), { recursive: true });
  const normalized = objects.replaceAll('\\', '/');
  let existing = '';
  try {
    existing = await readFile(alternates, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.split('\n').includes(normalized)) return;
  await writeFile(alternates, `${existing.trimEnd() ? `${existing.trimEnd()}\n` : ''}${normalized}\n`);
}

async function seedIndex(repository, source) {
  try {
    await copyFile(join(source.gitDirectory, 'index'), join(repository.gitDirectory, 'index'));
  } catch {
    // A fresh repository without an index simply rehashes on first capture.
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathspecFor(scope) {
  if (!scope || scope === '.') return '.';
  return `:(top,literal)${normalizeScope(scope)}`;
}

function normalizeScope(scope) {
  const normalized = String(scope).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized || '.';
}

export function literalPathspec(file) {
  return `:(literal)${file}`;
}

function nuls(text) {
  return text.split('\0').filter(Boolean);
}

function parseNameStatus(text) {
  const tokens = nuls(text);
  const entries = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const code = tokens[index];
    entries.push({
      status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified',
      file: tokens[index + 1],
    });
  }
  return entries;
}

function parseNumstat(text) {
  const stats = new Map();
  for (const record of nuls(text)) {
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const additions = record.slice(0, first);
    const deletions = record.slice(first + 1, second);
    const file = record.slice(second + 1);
    stats.set(
      file,
      additions === '-' || deletions === '-'
        ? { binary: true, additions: 0, deletions: 0 }
        : { binary: false, additions: Number(additions), deletions: Number(deletions) },
    );
  }
  return stats;
}

/**
 * Split a combined patch at its `diff --git` headers.
 *
 * A header has no `-z` form, so the chunks are matched positionally against the
 * `--name-status` listing: both are emitted in the same path order with
 * `--no-renames`.
 */
function splitPatch(text, files) {
  const chunks = new Map();
  if (!text) return chunks;
  const parts = text.split(/^(?=diff --git )/m).filter(Boolean);
  if (parts.length !== files.length) {
    // Fall back to header parsing rather than mislabeling patches.
    for (const part of parts) {
      const match = /^diff --git a\/(.*) b\/.*$/m.exec(part);
      if (match) chunks.set(match[1], part);
    }
    return chunks;
  }
  for (let index = 0; index < files.length; index += 1) chunks.set(files[index], parts[index]);
  return chunks;
}

export function canBatchRestore(files) {
  const canonical = files.every((file) =>
    file.split('/').every((part) => /^[\x20-\x7e]+$/.test(part) && !/[\\:]/.test(part) && !/[. ]$/.test(part)),
  );
  if (!canonical) return false;
  const folded = new Set(files.map((file) => file.toLowerCase()));
  if (folded.size !== files.length) return false;
  return files.every((file) => {
    const parts = file.toLowerCase().split('/');
    return parts.slice(1).every((_, index) => !folded.has(parts.slice(0, index + 1).join('/')));
  });
}

function normalizeRestoreInput(files) {
  if (files instanceof Map) return [...files].map(([file, tree]) => ({ file, tree }));
  if (Array.isArray(files)) return files.map((entry) => ({ file: entry.file, tree: entry.tree }));
  throw new SnapshotError('restore', 'restore expects a Map or an array of { file, tree }');
}

function validateRelativePath(file, worktree) {
  if (typeof file !== 'string' || !file) return 'empty path';
  if (isAbsolute(file) || /^[a-zA-Z]:/.test(file)) return 'path must not be absolute';
  const normalized = file.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) return 'path must not escape the worktree';
  const resolved = relative(worktree, join(worktree, normalized));
  if (resolved.startsWith('..') || isAbsolute(resolved)) return 'path must not escape the worktree';
  return undefined;
}

export function inside(parent, child) {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function message(error) {
  return error instanceof GitError ? error.message : (error?.message ?? String(error));
}
