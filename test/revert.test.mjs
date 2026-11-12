import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RevertService } from '../src/revert.mjs';
import { createState, listBackups, readState, writeState } from '../src/store.mjs';
import { surfaceNodes } from '../src/surface.mjs';
import { FakeSession, MemorySnapshot, seedThreeTurns, surfacePort } from './fake-session.mjs';

async function setup(t) {
  const root = join(process.cwd(), '.tmp', 'revert', randomUUID());
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const snapshot = new MemorySnapshot({ 'a.txt': 'a1' });
  const session = new FakeSession();
  const history = await seedThreeTurns(session, snapshot);

  const state = createState('session-1');
  state.snapshots = history.snapshots;
  await writeState(root, state);

  const service = new RevertService({ snapshot, session: surfacePort(session), root });
  return { root, snapshot, session, service, ...history };
}

const visible = (session) => surfaceNodes(session);

test('undo hides the tail on the surface and restores files to the boundary', async (t) => {
  const { root, snapshot, session, service, m3 } = await setup(t);
  const result = await service.undo({ seq: m3 });

  assert.equal(visible(session).includes(m3), false);
  assert.equal(snapshot.current.get('a.txt'), 'a2');
  // b.txt was created before the boundary, so undoing m3 keeps it.
  assert.equal(snapshot.current.get('b.txt'), 'b1');
  assert.equal(result.hidden.turns, 1);
  // Nothing is deleted from the append-only log; no v4 backup either.
  assert.equal(session.log.filter((event) => event.type === 'user/message').length, 3);
  assert.deepEqual(await listBackups(root, 'session-1'), []);

  const state = await readState(root, 'session-1');
  assert.equal(state.revert.seq, m3);
  assert.equal(state.revert.messageID, 'm3');
  assert.deepEqual(state.revert.files.map((entry) => entry.file), ['a.txt']);
});

test('redo steps forward one turn, then clears back to head', async (t) => {
  const { root, snapshot, session, service, m2, m3 } = await setup(t);
  await service.undo({ seq: m2 });
  assert.equal(visible(session).includes(m2), false);
  assert.equal(snapshot.current.get('a.txt'), 'a2');
  assert.equal(snapshot.current.has('b.txt'), false);

  const forward = await service.redo();
  assert.equal(forward.cleared, false);
  assert.equal(forward.boundarySeq, m3);
  // The copy of m2 is visible again; m3 is still hidden.
  const visibleUsers = () =>
    session.log.filter((event) => event.type === 'user/message' && visible(session).includes(event.seq)).map((event) => event.data.content[0].text);
  assert.deepEqual(visibleUsers(), ['m1', 'm2']);
  assert.equal(snapshot.current.get('a.txt'), 'a2');
  assert.equal(snapshot.current.get('b.txt'), 'b1');

  const cleared = await service.redo();
  assert.equal(cleared.cleared, true);
  assert.deepEqual(visibleUsers(), ['m1', 'm2', 'm3']);
  assert.equal(snapshot.current.get('a.txt'), 'a3');
  assert.equal(snapshot.current.get('b.txt'), 'b1');

  const state = await readState(root, 'session-1');
  assert.equal(state.revert, undefined);
});

test('undo twice and redo twice keeps one visible copy of each turn', async (t) => {
  const { snapshot, session, service, m1, m2, m3 } = await setup(t);
  await service.undo({ seq: m3 });
  await service.undo({ seq: m2 });

  const first = await service.redo();
  assert.equal(first.boundarySeq, m3);
  assert.equal(snapshot.current.get('a.txt'), 'a2');
  assert.equal(snapshot.current.get('b.txt'), 'b1');

  const second = await service.redo();
  assert.equal(second.cleared, true);
  assert.equal(snapshot.current.get('a.txt'), 'a3');

  const surfaceUser = session.log
    .filter((event) => event.type === 'user/message' && visible(session).includes(event.seq))
    .map((event) => event.data.content[0].text);
  assert.deepEqual(surfaceUser, ['m1', 'm2', 'm3']);
  assert.equal(new Set(surfaceUser).size, 3);
});

test('undo after a redo targets the visible copy, not the hidden original', async (t) => {
  const { snapshot, session, service, m2 } = await setup(t);
  await service.undo({ seq: m2 });
  await service.redo();

  const targets = await service.targets();
  const copy = targets.find((target) => target.originSeq === m2);
  assert.ok(copy, 'm2 is visible again through its copy');
  assert.notEqual(copy.seq, m2);
  assert.notEqual(copy.messageID, 'm2', 'the copy owns a fresh message id');
  assert.equal(copy.originSeq, m2);
  assert.equal(copy.hidden.turns, 1);

  const preview = await service.preview(copy.seq);
  assert.equal(preview.boundarySeq, copy.seq);
  assert.equal(preview.hidden.turns, 1);
  assert.deepEqual(preview.files.sort(), ['a.txt', 'b.txt']);

  await service.undo({ seq: copy.seq });
  assert.equal(visible(session).includes(copy.seq), false);
  assert.equal(snapshot.current.get('a.txt'), 'a2');
  assert.equal(snapshot.current.has('b.txt'), false);
});

test('redo replays only originals, never hidden copies', async (t) => {
  const { session, service, m1, m2 } = await setup(t);
  await service.undo({ seq: m2 });
  await service.redo();
  await service.undo({ seq: m1 });

  await service.redo();
  await service.redo();
  await service.redo();

  const surfaceUser = session.log
    .filter((event) => event.type === 'user/message' && visible(session).includes(event.seq))
    .map((event) => event.data.content[0].text);
  assert.deepEqual(surfaceUser, ['m1', 'm2', 'm3']);
  assert.equal(session.log.filter((event) => event.type === 'developer/message').length >= 2, true);
});

test('undo is idempotent only while the target is visible', async (t) => {
  const { service, m3 } = await setup(t);
  await service.undo({ seq: m3 });
  await assert.rejects(() => service.undo({ seq: m3 }), /已经不在当前对话中/);
});

test('commit drops the revert and makes redo impossible', async (t) => {
  const { root, snapshot, service, m3 } = await setup(t);
  await service.undo({ seq: m3 });
  const committed = await service.commit();
  assert.equal(committed.committedTo, 'm3');

  const state = await readState(root, 'session-1');
  assert.equal(state.revert, undefined);

  const redo = await service.redo();
  assert.equal(redo.done, false);
  assert.equal(snapshot.current.get('a.txt'), 'a2');
});

test('a rejected surface append leaves files and state untouched', async (t) => {
  const { root, snapshot, session, service, m3 } = await setup(t);
  session.failAppend = true;
  await assert.rejects(() => service.undo({ seq: m3 }), /append rejected/);

  assert.equal(snapshot.current.get('a.txt'), 'a3');
  assert.equal(visible(session).includes(m3), true);
  const state = await readState(root, 'session-1');
  assert.equal(state.revert, undefined);
});

test('redo refuses after the surface was rewritten by compaction', async (t) => {
  const { session, service, m3 } = await setup(t);
  await service.undo({ seq: m3 });

  const nodes = visible(session);
  session.append(
    'developer/message',
    { turn: 1, step: 1, message: { id: 'compaction-summary', role: 'developer', source: { kind: 'compaction' }, content: [] } },
    { surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) }, sourceEventSeqs: nodes },
  );

  await assert.rejects(() => service.redo(), /已被压缩或改写/);
});

test('preview reports boundary, hidden turns and files without mutating', async (t) => {
  const { snapshot, session, service, m2 } = await setup(t);
  const preview = await service.preview(m2);
  assert.equal(preview.boundarySeq, m2);
  assert.equal(preview.hidden.turns, 2);
  assert.deepEqual(preview.paths, ['b.txt', 'a.txt']);
  assert.deepEqual(preview.files.sort(), ['a.txt', 'b.txt']);
  assert.equal(snapshot.current.get('a.txt'), 'a3');
  assert.equal(visible(session).includes(m2), true);
});

test('targets list every visible turn with its undo cost', async (t) => {
  const { service } = await setup(t);
  const targets = await service.targets();
  assert.deepEqual(targets.map((target) => target.messageID), ['m1', 'm2', 'm3']);
  assert.deepEqual(targets.map((target) => target.hidden.turns), [3, 2, 1]);
});

test('conversation-only undo leaves the worktree alone', async (t) => {
  const { root, snapshot, session, service, m3 } = await setup(t);
  const result = await service.undo({ seq: m3, files: false });
  assert.equal(visible(session).includes(m3), false);
  assert.equal(snapshot.current.get('a.txt'), 'a3');
  assert.equal(snapshot.current.get('b.txt'), 'b1');
  assert.deepEqual(result.files, []);
  const state = await readState(root, 'session-1');
  assert.equal(state.revert.messageID, 'm3');
});

test('each undo marker gets its own message id', async (t) => {
  const { session, service, m3 } = await setup(t);
  await service.undo({ seq: m3 });
  await service.redo();
  await service.undo({ seq: (await service.targets()).find((target) => target.originSeq === m3).seq });

  const ids = session.log
    .filter((event) => event.type === 'developer/message')
    .map((event) => event.data.message.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});
