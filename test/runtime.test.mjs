import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RewindRuntime } from '../src/runtime.mjs';
import { readState } from '../src/store.mjs';
import { surfaceNodes } from '../src/surface.mjs';
import { workspaceDirectory } from '../src/paths.mjs';
import { assistant, FakeSession, MemorySnapshot, surfacePort, user } from './fake-session.mjs';

async function harness(t) {
  const root = join(process.cwd(), '.tmp', 'runtime', randomUUID());
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const cwd = 'D:/work';
  const snapshot = new MemorySnapshot({ 'a.txt': 'a0' });
  const session = new FakeSession();
  const port = surfacePort(session);
  const runtime = new RewindRuntime({
    root,
    portFor: async () => port,
    cwdOf: async () => cwd,
    openSnapshot: async () => snapshot,
  });
  return { root, cwd, snapshot, session, runtime, stateRoot: workspaceDirectory(root, cwd) };
}

/** a0 -> a1 -> a2 -> a3 driven through the real hooks. */
async function threeTurns(t) {
  const box = await harness(t);
  for (const [index, turn] of ['m1', 'm2', 'm3'].entries()) {
    await box.runtime.preStep({ session: box.session });
    box.session.append('turn/start', { turn: index + 1 });
    box.session.append('step/start', { turn: index + 1, step: 1 });
    box.session.append('user/message', user(turn, turn), { surfaceOp: 'append' });
    box.snapshot.current.set('a.txt', `a${index + 1}`);
    const logged = box.session.append(
      'assistant/message',
      { turn: index + 1, step: 1, message: assistant(`a${index + 1}`), stream: [] },
      { surfaceOp: 'append' },
    );
    await box.runtime.event({ session: box.session, event: logged });
    box.session.append('step/end', { turn: index + 1, step: 1 });
    box.session.append('turn/end', { turn: index + 1, reason: 'done' });
  }
  return box;
}

const visibleUsers = (session) =>
  session.log.filter((event) => event.type === 'user/message' && surfaceNodes(session).includes(event.seq)).map((event) => event.data.content[0].text);
const visibleAssistants = (session) =>
  session.log.filter((event) => event.type === 'assistant/message' && surfaceNodes(session).includes(event.seq)).map((event) => event.seq);

test('pre-step and assistant events build one snapshot per step', async (t) => {
  const box = await threeTurns(t);
  const state = await readState(box.stateRoot, 'session-1');
  assert.equal(Object.keys(state.snapshots).length, 3);
  const entries = Object.values(state.snapshots);
  assert.deepEqual(entries.map((entry) => entry.files), [['a.txt'], ['a.txt'], ['a.txt']]);
  assert.equal(entries[0].end, entries[1].start);
});

test('undo through the runtime hides the tail and restores the worktree', async (t) => {
  const box = await threeTurns(t);
  const targets = await box.runtime.targets(box.session);
  const m3 = targets.find((target) => target.messageID === 'm3');
  await box.runtime.undo({ session: box.session, seq: m3.seq });

  assert.deepEqual(visibleUsers(box.session), ['m1', 'm2']);
  assert.equal(box.snapshot.current.get('a.txt'), 'a2');

  const status = await box.runtime.status(box.session);
  assert.equal(status.revert.messageID, 'm3');
  assert.equal(status.redoAvailable, true);
});

test('redo walks forward and then clears', async (t) => {
  const box = await threeTurns(t);
  const targets = await box.runtime.targets(box.session);
  const m2 = targets.find((target) => target.messageID === 'm2');
  await box.runtime.undo({ session: box.session, seq: m2.seq });
  assert.deepEqual(visibleUsers(box.session), ['m1']);
  assert.equal(box.snapshot.current.get('a.txt'), 'a1');

  const forward = await box.runtime.redo({ session: box.session });
  assert.equal(forward.cleared, false);
  assert.deepEqual(visibleUsers(box.session), ['m1', 'm2']);
  assert.equal(box.snapshot.current.get('a.txt'), 'a2');

  const cleared = await box.runtime.redo({ session: box.session });
  assert.equal(cleared.cleared, true);
  assert.deepEqual(visibleUsers(box.session), ['m1', 'm2', 'm3']);
  assert.equal(box.snapshot.current.get('a.txt'), 'a3');
});

test('a queued user turn commits the revert before the next step runs', async (t) => {
  const box = await threeTurns(t);
  const targets = await box.runtime.targets(box.session);
  const m3 = targets.find((target) => target.messageID === 'm3');
  await box.runtime.undo({ session: box.session, seq: m3.seq });

  box.session.append('turn/start', { turn: 4 });
  box.session.append('user/message', user('m4', 'm4'), { surfaceOp: 'append' });
  await box.runtime.preStep({ session: box.session });

  const state = await readState(box.stateRoot, 'session-1');
  assert.equal(state.revert, undefined);
  assert.equal(Object.keys(state.snapshots).length, 3);
});

test('hidden originals and redo copies never commit a live revert', async (t) => {
  const box = await threeTurns(t);
  const targets = await box.runtime.targets(box.session);
  const m2 = targets.find((target) => target.messageID === 'm2');
  await box.runtime.undo({ session: box.session, seq: m2.seq });
  await box.runtime.redo({ session: box.session });

  // A pre-step right after redo must keep the revert: the copied m2 turn is
  // visible, but no *new* user message has arrived.
  await box.runtime.preStep({ session: box.session });
  const state = await readState(box.stateRoot, 'session-1');
  assert.ok(state.revert, 'the revert stays live until a new user message arrives');
});

test('redo copies do not create snapshots or move files', async (t) => {
  const box = await threeTurns(t);
  const targets = await box.runtime.targets(box.session);
  const m3 = targets.find((target) => target.messageID === 'm3');
  await box.runtime.undo({ session: box.session, seq: m3.seq });

  const before = Object.keys((await readState(box.stateRoot, 'session-1')).snapshots).sort();
  const copySeqsBefore = box.session.log.filter((event) => event.type === 'assistant/message').map((event) => event.seq);
  await box.runtime.redo({ session: box.session });
  const appended = box.session.log.filter((event) => event.type === 'assistant/message').map((event) => event.seq).slice(copySeqsBefore.length);

  for (const seq of appended) {
    await box.runtime.event({ session: box.session, event: box.session.log.find((event) => event.seq === seq) });
  }
  const after = Object.keys((await readState(box.stateRoot, 'session-1')).snapshots).sort();
  assert.deepEqual(after, before);
});

test('undo is refused while a step is in flight', async (t) => {
  const box = await threeTurns(t);
  await box.runtime.preStep({ session: box.session });
  await assert.rejects(() => box.runtime.undo({ session: box.session, seq: 0 }), /正在执行/);
});

test('targets and preview describe the undo without applying it', async (t) => {
  const box = await threeTurns(t);
  const targets = await box.runtime.targets(box.session);
  assert.deepEqual(targets.map((target) => target.messageID), ['m1', 'm2', 'm3']);

  const preview = await box.runtime.preview(box.session, targets[1].seq);
  assert.equal(preview.boundarySeq, targets[1].seq);
  assert.deepEqual(preview.paths, ['a.txt']);
  assert.deepEqual(visibleUsers(box.session), ['m1', 'm2', 'm3']);
});
