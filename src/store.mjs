import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sessionStatePath } from './paths.mjs';

export const SCHEMA = 1;

export class StateError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StateError';
    if (cause) this.cause = cause;
  }
}

export function createState(sessionId) {
  return {
    schema: SCHEMA,
    sessionId,
    revision: 0,
    snapshots: {},
    hostChecks: {},
  };
}

export function validateState(value, sessionId) {
  if (!value || typeof value !== 'object') throw new StateError('rewind state is not an object');
  if (value.schema !== SCHEMA) throw new StateError(`unsupported rewind state schema ${value.schema}`);
  if (sessionId !== undefined && value.sessionId !== sessionId) {
    throw new StateError(`rewind state belongs to session ${value.sessionId}, not ${sessionId}`);
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new StateError('rewind state has no revision');
  if (!value.snapshots || typeof value.snapshots !== 'object') throw new StateError('rewind state has no snapshots');
  for (const [seq, snapshot] of Object.entries(value.snapshots)) {
    if (!/^\d+$/.test(seq)) throw new StateError(`rewind snapshot key ${seq} is not a sequence number`);
    if (!snapshot || typeof snapshot !== 'object') throw new StateError(`rewind snapshot ${seq} is not an object`);
    for (const field of ['start', 'end']) {
      const tree = snapshot[field];
      if (tree !== undefined && !/^[0-9a-f]{40,64}$/.test(tree)) {
        throw new StateError(`rewind snapshot ${seq} has an invalid ${field} tree`);
      }
    }
    if (snapshot.files !== undefined && !Array.isArray(snapshot.files)) {
      throw new StateError(`rewind snapshot ${seq} has invalid files`);
    }
  }
  const revert = value.revert;
  if (revert !== undefined) {
    if (typeof revert.messageID !== 'string' || !Number.isInteger(revert.seq)) {
      throw new StateError('rewind revert has no message or boundary');
    }
    if (revert.snapshot !== undefined && !/^[0-9a-f]{40,64}$/.test(revert.snapshot)) {
      throw new StateError('rewind revert has an invalid head tree');
    }
    if (!Array.isArray(revert.files)) throw new StateError('rewind revert has no file list');
    for (const entry of revert.files) {
      if (!entry || typeof entry.file !== 'string') throw new StateError('rewind revert has an invalid file entry');
    }
    if (revert.surface !== undefined) {
      const surface = revert.surface;
      if (!surface || typeof surface !== 'object') throw new StateError('rewind revert has an invalid surface generation');
      for (const field of ['replaceGeneration', 'contentGeneration']) {
        if (!Number.isInteger(surface[field]) || surface[field] < 0) {
          throw new StateError(`rewind revert has an invalid ${field}`);
        }
      }
    }
  }
  if (value.copies !== undefined) {
    if (!value.copies || typeof value.copies !== 'object') throw new StateError('rewind state has invalid copies');
    for (const [seq, origin] of Object.entries(value.copies)) {
      if (!/^\d+$/.test(seq) || !Number.isInteger(origin) || origin < 0) {
        throw new StateError('rewind state has an invalid copy mapping');
      }
    }
  }
  return value;
}

export async function readState(root, sessionId) {
  const path = sessionStatePath(root, sessionId);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return createState(sessionId);
    throw new StateError(`failed to read rewind state: ${error.message}`, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StateError(`rewind state at ${path} is not valid JSON`, error);
  }
  return validateState(parsed, sessionId);
}

export async function writeState(root, state) {
  const next = { ...state, schema: SCHEMA, revision: state.revision + 1 };
  validateState(next, next.sessionId);
  await atomicJson(sessionStatePath(root, next.sessionId), next);
  return next;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Exclusive workspace lock.
 *
 * Undo mutates files and the session log, so two sessions in the same worktree
 * must not interleave. The lock file records the owner so a stale lock from a
 * killed process is identifiable instead of blocking forever.
 */
export async function acquireLock(root, { owner, staleMs = 15 * 60 * 1000 } = {}) {
  const path = join(root, 'locks', 'workspace.lock');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ owner, pid: process.pid, at: Date.now() }));
      await handle.close();
      return {
        path,
        async release() {
          await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 1 || !(await isStale(path, staleMs))) {
        throw new StateError('another session is currently rewinding this workspace');
      }
      await rm(path, { force: true });
    }
  }
  throw new StateError('another session is currently rewinding this workspace');
}

async function isStale(path, staleMs) {
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    return !Number.isInteger(record.at) || Date.now() - record.at > staleMs;
  } catch {
    return true;
  }
}
