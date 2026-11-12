import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from '../src/git.mjs';
import { SnapshotService } from '../src/snapshot.mjs';
import { SnapshotRecorder } from '../src/collect.mjs';
import { readState } from '../src/store.mjs';

async function workspace(t) {
  const base = join(process.cwd(), '.tmp', 'collect', randomUUID());
  const work = join(base, 'work');
  await mkdir(work, { recursive: true });
  await git(['init', '--quiet', work], { tmp: base });
  t.after(() => rm(base, { recursive: true, force: true }));
  const snapshot = await SnapshotService.open({ worktree: work, root: join(base, 'rewind'), tmp: base });
  const root = join(base, 'state');
  const recorder = new SnapshotRecorder({ snapshot, root, sessionId: 'session-1' });
  const write = (file, content) => writeFile(join(work, file), content);
  return { base, work, snapshot, root, recorder, write };
}

test('a step records its start and end tree plus changed files', async (t) => {
  const box = await workspace(t);
  await box.write('a.txt', 'a1');
  const start = await box.recorder.begin(2);
  assert.match(start.start, /^[0-9a-f]{40,64}$/);

  await box.write('a.txt', 'a2');
  await box.write('b.txt', 'b1');
  const { snapshot } = await box.recorder.end(2);

  assert.equal(snapshot.start, start.start);
  assert.notEqual(snapshot.end, snapshot.start);
  assert.deepEqual(snapshot.files.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual((await readState(box.root, 'session-1')).snapshots[2], snapshot);
});

test('begin is idempotent so a retried step keeps its original boundary', async (t) => {
  const box = await workspace(t);
  await box.write('a.txt', 'a1');
  const first = await box.recorder.begin(2);
  await box.write('a.txt', 'a2');
  const second = await box.recorder.begin(2);
  assert.equal(second.start, first.start);
});

test('a step without a pre-capture never claims files', async (t) => {
  const box = await workspace(t);
  await box.write('a.txt', 'a1');
  const { snapshot } = await box.recorder.end(4);
  assert.equal(snapshot.start, snapshot.end);
  assert.deepEqual(snapshot.files, []);
});

test('a step that changed nothing records no files', async (t) => {
  const box = await workspace(t);
  await box.write('a.txt', 'a1');
  await box.recorder.begin(2);
  const { snapshot } = await box.recorder.end(2);
  assert.deepEqual(snapshot.files, []);
  assert.equal(snapshot.start, snapshot.end);
});

test('uncovered paths are reported with the step', async (t) => {
  const box = await workspace(t);
  const recorder = new SnapshotRecorder({ snapshot: box.snapshot, root: box.root, sessionId: 'session-1', maxUntrackedBytes: 1024 });
  await recorder.begin(2);
  await writeFile(join(box.work, 'huge.bin'), Buffer.alloc(2048, 1));
  const { uncovered } = await recorder.end(2);
  assert.deepEqual(uncovered, [{ file: 'huge.bin', reason: 'untracked file over the size limit' }]);
});

test('forget removes a step that never produced a message', async (t) => {
  const box = await workspace(t);
  await box.recorder.begin(2);
  assert.equal(await box.recorder.forget(2), true);
  assert.equal(await box.recorder.forget(2), false);
  assert.deepEqual((await readState(box.root, 'session-1')).snapshots, {});
});
