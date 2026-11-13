import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sessionStatePath } from './paths.mjs';

/**
 * Per-session rewind state (schema 2).
 *
 * The log is the durable truth; this file only remembers:
 *   - `snapshots`: the worktree tree captured around each step;
 *   - `undo` / `redo`: the view stack, where an entry is one applied rewind;
 *   - `hiddenRanges` / `internalRanges`: what a client should hide, and which
 *     log ranges belong to this plugin's maintenance turns;
 *   - `journal`: the one in-flight operation, so a crash never leaves files and
 *     conversation out of step.
 */
export const SCHEMA = 2;
export const TREE = /^[0-9a-f]{40,64}$/;

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
    copies: {},
    view: { cut: null },
    undo: [],
    redo: [],
    hiddenRanges: [],
    internalRanges: [],
    journal: null,
  };
}

function assertRanges(value, field) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new StateError(`rewind state has invalid ${field}`);
  for (const range of value) {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start > range.end) {
      throw new StateError(`rewind state has an invalid ${field} entry`);
    }
  }
}

function assertEntry(entry, field) {
  if (!entry || typeof entry !== 'object') throw new StateError(`rewind state has an invalid ${field} entry`);
  if (typeof entry.id !== 'string' || !entry.id) throw new StateError(`rewind ${field} entry has no id`);
  if (!Number.isSafeInteger(entry.targetSeq) || entry.targetSeq < 0) throw new StateError(`rewind ${field} entry has no target`);
  if (!Number.isSafeInteger(entry.beforeSeq) || entry.beforeSeq < 0) throw new StateError(`rewind ${field} entry has no origin`);
  if (entry.endSeq !== undefined && (!Number.isSafeInteger(entry.endSeq) || entry.endSeq < 0)) {
    throw new StateError(`rewind ${field} entry has an invalid end`);
  }
  if (entry.files !== undefined && !Array.isArray(entry.files)) throw new StateError(`rewind ${field} entry has invalid files`);
  for (const file of entry.files ?? []) if (typeof file !== 'string') throw new StateError(`rewind ${field} entry has an invalid file`);
  if (entry.head !== undefined && entry.head !== null && !TREE.test(entry.head)) {
    throw new StateError(`rewind ${field} entry has an invalid head tree`);
  }
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
      if (tree !== undefined && !TREE.test(tree)) throw new StateError(`rewind snapshot ${seq} has an invalid ${field} tree`);
    }
    if (snapshot.files !== undefined && !Array.isArray(snapshot.files)) {
      throw new StateError(`rewind snapshot ${seq} has invalid files`);
    }
  }
  const view = value.view ?? { cut: null };
  if (view.cut !== null && (!Number.isSafeInteger(view.cut) || view.cut < 0)) throw new StateError('rewind state has an invalid view');
  assertRanges(value.hiddenRanges, 'hiddenRanges');
  assertRanges(value.internalRanges, 'internalRanges');
  for (const field of ['undo', 'redo']) {
    const stack = value[field];
    if (stack === undefined) continue;
    if (!Array.isArray(stack)) throw new StateError(`rewind state has an invalid ${field} stack`);
    for (const entry of stack) assertEntry(entry, field);
  }
  if (value.copies !== undefined) {
    if (!value.copies || typeof value.copies !== 'object') throw new StateError('rewind state has invalid copies');
    for (const [seq, origin] of Object.entries(value.copies)) {
      if (!/^\d+$/.test(seq) || !Number.isSafeInteger(origin) || origin < 0) {
        throw new StateError('rewind state has an invalid copy mapping');
      }
    }
  }
  if (value.journal !== undefined && value.journal !== null) {
    const journal = value.journal;
    if (!journal || typeof journal !== 'object') throw new StateError('rewind state has an invalid journal');
    if (typeof journal.id !== 'string' || !journal.id) throw new StateError('rewind journal has no id');
    if (!['undo', 'redo'].includes(journal.op)) throw new StateError('rewind journal has an invalid operation');
    if (!journal.state || typeof journal.state !== 'object') throw new StateError('rewind journal has no planned state');
  }
  return { ...value, copies: value.copies ?? {}, view, undo: value.undo ?? [], redo: value.redo ?? [], hiddenRanges: value.hiddenRanges ?? [], internalRanges: value.internalRanges ?? [], journal: value.journal ?? null };
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
  if (parsed?.schema === 1) return createState(sessionId);
  return validateState(parsed, sessionId);
}

export async function writeState(root, state) {
  const next = validateState({ ...state, schema: SCHEMA, revision: state.revision + 1 }, state.sessionId);
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
 * A rewind mutates files and the session log, so two sessions sharing one
 * worktree must not interleave. The lock records its owner so a lock from a
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
        throw new StateError('工作区正在被另一个会话回退，请稍后再试');
      }
      await rm(path, { force: true });
    }
  }
  throw new StateError('工作区正在被另一个会话回退，请稍后再试');
}

async function isStale(path, staleMs) {
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    return !Number.isInteger(record.at) || Date.now() - record.at > staleMs;
  } catch {
    return true;
  }
}

/** A short, stable id for one rewind operation. */
export function operationId() {
  return randomUUID();
}
