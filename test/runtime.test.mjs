import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgent, FakeSession, MemorySnapshot, detached } from './fake-session.mjs';
import { RewindRuntime } from '../src/runtime.mjs';
import { readState } from '../src/store.mjs';
import { itemsOf } from '../src/history.mjs';

const texts = (session) =>
  itemsOf(session).map((item) => {
    const message = item.type === 'user/message' ? item.data : item.data.message;
    return message.content?.[0]?.text ?? '';
  });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-undo-runtime-'));
  const session = new FakeSession();
  const files = new MemorySnapshot({ 'a.txt': 'a1' });
  const runtime = new RewindRuntime({
    root,
    host: {
      available: true,
      createDetached: detached,
      appendPluginRecord: (target, type, data) => target.append(type, data),
    },
    cwdOf: async () => 'D:/work',
    flush: async () => {},
    probeGit: async () => true,
    openSnapshot: async () => files,
  });
  session.listeners.push((target, event) => runtime.event(target, event));
  const agent = new FakeAgent(session, { preStep: (payload, next) => runtime.preStep(payload, next) });
  const dispose = () => rm(root, { recursive: true, force: true });
  return { root, session, files, runtime, agent, dispose };
}

async function seed(agent, files) {
  const turns = [];
  turns.push(await agent.turnWith('one', { before: async () => files.current.set('a.txt', 'a2') }));
  turns.push(await agent.turnWith('two', { before: async () => files.current.set('b.txt', 'b1') }));
  turns.push(await agent.turnWith('three', { before: async () => files.current.set('a.txt', 'a3') }));
  return turns;
}

test('undo rewinds the conversation and the files, and the log still reloads', async () => {
  const { root, session, files, runtime, agent, dispose } = await setup();
  try {
    const turns = await seed(agent, files);
    await runtime.settle();

    const result = await runtime.undo({ agent, seq: turns[1].userSeq });
    assert.equal(result.files, 2);
    await runtime.settle();

    // The durable log must replay from scratch: this is the v6 acceptance test.
    const reloaded = new FakeSession({ log: session.snapshotEvents() });
    assert.deepEqual(texts(reloaded), ['one', 'answer 1']);
    assert.equal(files.current.get('a.txt'), 'a2');
    assert.equal(files.current.has('b.txt'), false);

    const persisted = await readState(root, session.id);
    assert.equal(persisted.undo.length, 1);
    assert.equal(persisted.redo.length, 0);
    assert.equal(persisted.journal, null);
    assert.ok(persisted.hiddenRanges.length > 0);
    assert.equal(persisted.view.cut, turns[1].userSeq);
  } finally {
    await dispose();
  }
});

test('redo re-applies the view that the undo replaced', async () => {
  const { root, session, files, runtime, agent, dispose } = await setup();
  try {
    const turns = await seed(agent, files);
    await runtime.settle();
    await runtime.undo({ agent, seq: turns[1].userSeq });
    await runtime.settle();

    await runtime.redo({ agent });
    await runtime.settle();

    const reloaded = new FakeSession({ log: session.snapshotEvents() });
    assert.deepEqual(texts(reloaded), ['one', 'answer 1', 'two', 'answer 2', 'three', 'answer 3']);
    assert.equal(files.current.get('a.txt'), 'a3');
    assert.equal(files.current.get('b.txt'), 'b1');

    const persisted = await readState(root, session.id);
    assert.equal(persisted.undo.length, 0);
    assert.equal(persisted.redo.length, 1);
    assert.equal(persisted.journal, null);
  } finally {
    await dispose();
  }
});

test('undo after redo rewinds again', async () => {
  const { session, files, runtime, agent, dispose } = await setup();
  try {
    const turns = await seed(agent, files);
    await runtime.settle();
    await runtime.undo({ agent, seq: turns[1].userSeq });
    await runtime.redo({ agent });
    const again = runtime.targets(session)[1];
    await runtime.undo({ agent, seq: again.seq });
    await runtime.settle();

    const reloaded = new FakeSession({ log: session.snapshotEvents() });
    assert.deepEqual(texts(reloaded), ['one', 'answer 1']);
    assert.equal(files.current.get('a.txt'), 'a2');
  } finally {
    await dispose();
  }
});

test('a new message after an undo makes redo unavailable', async () => {
  const { files, runtime, agent, dispose } = await setup();
  try {
    const turns = await seed(agent, files);
    await runtime.settle();
    await runtime.undo({ agent, seq: turns[1].userSeq });
    await runtime.settle();

    await agent.turnWith('fresh start');
    await runtime.settle();
    await assert.rejects(() => runtime.redo({ agent }), /无法重做/);
  } finally {
    await dispose();
  }
});

test('undo rejects a target that is not on the surface', async () => {
  const { files, runtime, agent, dispose } = await setup();
  try {
    await seed(agent, files);
    await runtime.settle();
    await assert.rejects(() => runtime.undo({ agent, seq: 9999 }), /不在当前对话中/);
  } finally {
    await dispose();
  }
});

