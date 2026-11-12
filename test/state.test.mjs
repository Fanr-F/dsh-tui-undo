import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  StateError,
  acquireLock,
  createState,
  readState,
  validateState,
  writeState,
} from '../src/store.mjs';
import { sessionStatePath } from '../src/paths.mjs';

async function store(t) {
  const root = join(process.cwd(), '.tmp', 'store', randomUUID());
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('state round-trips and every write bumps the revision', async (t) => {
  const root = await store(t);
  assert.deepEqual(await readState(root, 'session-a'), createState('session-a'));

  const first = await writeState(root, { ...createState('session-a'), snapshots: { 2: { start: 'a'.repeat(40), files: ['a.txt'] } } });
  assert.equal(first.revision, 1);
  const second = await writeState(root, first);
  assert.equal(second.revision, 2);

  const loaded = await readState(root, 'session-a');
  assert.deepEqual(loaded.snapshots, { 2: { start: 'a'.repeat(40), files: ['a.txt'] } });
  assert.equal(loaded.revision, 2);
});

test('invalid state is rejected instead of silently repaired', async (t) => {
  const root = await store(t);
  assert.throws(() => validateState({ ...createState('s'), schema: 99 }, 's'), StateError);
  assert.throws(() => validateState({ ...createState('s'), snapshots: { x: {} } }, 's'), /not a sequence number/);
  assert.throws(() => validateState({ ...createState('s'), snapshots: { 2: { start: 'nope' } } }, 's'), /invalid start tree/);
  assert.throws(() => validateState(createState('other'), 's'), /belongs to session/);

  const path = sessionStatePath(root, 'broken');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '{not json');
  await assert.rejects(() => readState(root, 'broken'), /not valid JSON/);
});

test('the workspace lock excludes a second session and reclaims stale locks', async (t) => {
  const root = await store(t);
  const lock = await acquireLock(root, { owner: 'session-a' });
  await assert.rejects(() => acquireLock(root, { owner: 'session-b' }), /another session/);
  await lock.release();
  const again = await acquireLock(root, { owner: 'session-b' });
  await again.release();

  const path = join(root, 'locks', 'workspace.lock');
  await writeFile(path, JSON.stringify({ owner: 'dead', pid: 1, at: Date.now() - 60 * 60 * 1000 }));
  const reclaimed = await acquireLock(root, { owner: 'session-c' });
  await reclaimed.release();
});
