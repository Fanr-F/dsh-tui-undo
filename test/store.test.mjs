import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEMA,
  StateError,
  createState,
  readState,
  validateState,
  writeState,
} from '../src/store.mjs';
import { sessionStatePath } from '../src/paths.mjs';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-undo-state-'));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('createState starts an empty schema 2 document', () => {
  const state = createState('s1');
  assert.equal(state.schema, SCHEMA);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.undo, []);
  assert.deepEqual(state.redo, []);
  assert.deepEqual(state.hiddenRanges, []);
  assert.equal(state.journal, null);
});

test('writeState validates and bumps the revision', async () => {
  const root = await workspace();
  try {
    const first = await writeState(root.root, createState('s1'));
    assert.equal(first.revision, 1);
    const second = await writeState(root.root, first);
    assert.equal(second.revision, 2);
    const read = await readState(root.root, 's1');
    assert.equal(read.revision, 2);
  } finally {
    await root.dispose();
  }
});

test('a missing state file is an empty state', async () => {
  const root = await workspace();
  try {
    const state = await readState(root.root, 'never-seen');
    assert.equal(state.revision, 0);
  } finally {
    await root.dispose();
  }
});

test('a schema 1 file is discarded rather than migrated', async () => {
  const root = await workspace();
  try {
    const path = sessionStatePath(root.root, 's1');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ schema: 1, sessionId: 's1', revision: 4, snapshots: {}, revert: {} }));
    const state = await readState(root.root, 's1');
    assert.equal(state.schema, SCHEMA);
    assert.equal(state.revision, 0);
  } finally {
    await root.dispose();
  }
});

test('validateState rejects malformed undo entries and ranges', () => {
  const base = createState('s1');
  assert.throws(() => validateState({ ...base, schema: 99 }), /unsupported rewind state schema/);
  assert.throws(() => validateState({ ...base, hiddenRanges: [{ start: 5, end: 2 }] }), /invalid hiddenRanges/);
  assert.throws(
    () => validateState({ ...base, undo: [{ id: 'x', targetSeq: 4 }] }),
    /has no origin/,
  );
  assert.throws(
    () =>
      validateState({
        ...base,
        undo: [{ id: 'x', targetSeq: 4, beforeSeq: 9, head: 'not-a-tree' }],
      }),
    /invalid head tree/,
  );
  const valid = validateState({
    ...base,
    undo: [{ id: 'x', targetSeq: 4, beforeSeq: 9, endSeq: 12, files: ['a.txt'], head: 'a'.repeat(40) }],
    journal: { id: 'x', op: 'undo', turn: 3, startSeq: 9, state: base, rollback: { head: null, files: [] } },
  });
  assert.equal(valid.undo.length, 1);
});

test('validateState rejects a state for another session', () => {
  assert.throws(() => validateState(createState('s1'), 's2'), /belongs to session/);
});
