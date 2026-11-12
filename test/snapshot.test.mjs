import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { git } from '../src/git.mjs';
import { SnapshotService } from '../src/snapshot.mjs';

const BASE = join(process.cwd(), '.tmp');

async function sandbox(t) {
  const directory = join(BASE, randomUUID());
  const work = join(directory, 'work');
  const store = join(directory, 'store');
  const tmp = join(directory, 'tmp');
  await mkdir(work, { recursive: true });
  await mkdir(store, { recursive: true });
  await mkdir(tmp, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, work, store, tmp };
}

async function repository(t) {
  const box = await sandbox(t);
  await git(['init', '--quiet', box.work], { tmp: box.tmp });
  box.snapshot = await SnapshotService.open({ worktree: box.work, root: box.store, tmp: box.tmp });
  return box;
}

const write = (box, file, content) => writeFile(join(box.work, file), content);
const read = (box, file) => readFile(join(box.work, file), 'utf8');
const exists = (box, file) => readFile(join(box.work, file)).then(() => true, () => false);

test('capture, compare and restore a step', async (t) => {
  const box = await repository(t);
  await write(box, 'a.txt', 'a1');
  await write(box, 'b.txt', 'keep');
  await write(box, 'c.txt', 'remove');
  const start = (await box.snapshot.capture()).tree;

  await write(box, 'a.txt', 'a2');
  await write(box, 'd.txt', 'new');
  await rm(join(box.work, 'c.txt'));
  const end = (await box.snapshot.capture()).tree;

  assert.deepEqual((await box.snapshot.files(start, end)).sort(), ['a.txt', 'c.txt', 'd.txt']);
  const diff = await box.snapshot.diff(start, end);
  assert.deepEqual(
    diff.map((entry) => [entry.file, entry.status]).sort(),
    [['a.txt', 'modified'], ['c.txt', 'deleted'], ['d.txt', 'added']],
  );
  assert.match(diff.find((entry) => entry.file === 'a.txt').patch, /^-a1$/m);
  assert.match(diff.find((entry) => entry.file === 'a.txt').patch, /^\+a2$/m);

  const result = await box.snapshot.restore(
    new Map([
      ['a.txt', start],
      ['c.txt', start],
      ['d.txt', start],
    ]),
  );
  assert.deepEqual(result.failed, []);
  assert.equal(await read(box, 'a.txt'), 'a1');
  assert.equal(await read(box, 'c.txt'), 'remove');
  assert.equal(await exists(box, 'd.txt'), false);
  assert.equal(await read(box, 'b.txt'), 'keep');
});

test('restore keeps binary bytes identical', async (t) => {
  const box = await repository(t);
  const original = randomBytes(4096);
  await writeFile(join(box.work, 'blob.bin'), original);
  const start = (await box.snapshot.capture()).tree;
  await writeFile(join(box.work, 'blob.bin'), randomBytes(1024));
  const end = (await box.snapshot.capture()).tree;

  const diff = await box.snapshot.diff(start, end);
  assert.equal(diff[0].binary, true);
  assert.equal(diff[0].patch, '');

  await box.snapshot.restore(new Map([['blob.bin', start]]));
  assert.deepEqual(await readFile(join(box.work, 'blob.bin')), original);
});

test('captures a directory that is not a git repository', async (t) => {
  const box = await sandbox(t);
  box.snapshot = await SnapshotService.open({ worktree: box.work, root: box.store, tmp: box.tmp });
  await write(box, 'notes.md', 'v1');
  const start = (await box.snapshot.capture()).tree;
  await write(box, 'notes.md', 'v2');
  await write(box, 'extra.md', 'x');
  const end = (await box.snapshot.capture()).tree;

  assert.deepEqual((await box.snapshot.files(start, end)).sort(), ['extra.md', 'notes.md']);
  await box.snapshot.restore(new Map([['notes.md', start], ['extra.md', start]]));
  assert.equal(await read(box, 'notes.md'), 'v1');
  assert.equal(await exists(box, 'extra.md'), false);
});

test('reports untracked files above the size limit instead of capturing them', async (t) => {
  const box = await repository(t);
  await write(box, 'a.txt', 'a1');
  await writeFile(join(box.work, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  const captured = await box.snapshot.capture({ maxUntrackedBytes: 1024 * 1024 });

  assert.deepEqual(captured.uncovered, [{ file: 'huge.bin', reason: 'untracked file over the size limit' }]);
  assert.deepEqual(await box.snapshot.listTree(captured.tree), ['a.txt']);
  await write(box, 'a.txt', 'a2');
  await box.snapshot.restore(new Map([['a.txt', captured.tree]]));
  assert.equal(await read(box, 'a.txt'), 'a1');
  assert.equal(await exists(box, 'huge.bin'), true);
});

test('a missing tree fails the restore and never deletes the file', async (t) => {
  const box = await repository(t);
  await write(box, 'a.txt', 'a1');
  const result = await box.snapshot.restore(new Map([['a.txt', 'f'.repeat(40)]]));

  assert.equal(result.restored.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].message, /no longer available/);
  assert.equal(await read(box, 'a.txt'), 'a1');
});

test('embedded repositories are excluded from the snapshot', async (t) => {
  const box = await repository(t);
  await write(box, 'a.txt', 'a1');
  await mkdir(join(box.work, 'vendor'));
  await git(['init', '--quiet', join(box.work, 'vendor')], { tmp: box.tmp });
  await writeFile(join(box.work, 'vendor', 'inner.txt'), 'inner');

  const captured = await box.snapshot.capture();
  assert.deepEqual(captured.uncovered, [{ file: 'vendor', reason: 'embedded repository' }]);
  assert.deepEqual(await box.snapshot.listTree(captured.tree), ['a.txt']);
  assert.equal(await readFile(join(box.work, 'vendor', 'inner.txt'), 'utf8'), 'inner');
});

test('selective restore rebuilds any intermediate step from its own trees', async (t) => {
  const box = await repository(t);
  await write(box, 'a.txt', 'a1');
  await write(box, 'b.txt', 'b1');
  const t0 = (await box.snapshot.capture()).tree;

  await write(box, 'a.txt', 'a2');
  const t1 = (await box.snapshot.capture()).tree;

  await write(box, 'b.txt', 'b2');
  const t2 = (await box.snapshot.capture()).tree;

  await write(box, 'a.txt', 'a3');
  await write(box, 'b.txt', 'b3');

  // Undo to step 1: files touched after it come from that step's start tree.
  await box.snapshot.restore(new Map([['a.txt', t1], ['b.txt', t2]]));
  assert.equal(await read(box, 'a.txt'), 'a2');
  assert.equal(await read(box, 'b.txt'), 'b2');

  // Redo to the end from the head snapshot of the untouched step zero.
  await box.snapshot.restore(new Map([['a.txt', 'a3'], ['b.txt', 'b3']].map(([file]) => [file, t1])));
  assert.deepEqual((await box.snapshot.files(t0, t2)).sort(), ['a.txt', 'b.txt']);
});

test('rejects paths that escape the worktree', async (t) => {
  const box = await repository(t);
  await write(box, 'a.txt', 'a1');
  const tree = (await box.snapshot.capture()).tree;
  const result = await box.snapshot.restore(
    new Map([
      ['../escape.txt', tree],
      ['C:/windows/evil.txt', tree],
    ]),
  );
  assert.equal(result.restored.length, 0);
  assert.equal(result.failed.length, 2);
});

test('the store may not overlap the worktree', async (t) => {
  const box = await sandbox(t);
  await assert.rejects(
    () => SnapshotService.open({ worktree: box.work, root: join(box.work, '.store'), tmp: box.tmp }),
    /must not overlap/,
  );
});

test('reuses one shadow repository per worktree', async (t) => {
  const box = await repository(t);
  const first = box.snapshot.gitDirectory;
  const second = await SnapshotService.open({ worktree: box.work, root: box.store, tmp: box.tmp });
  assert.equal(second.gitDirectory, first);
});
