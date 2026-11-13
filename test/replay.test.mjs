import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSession, MemorySnapshot, assistant, detached, seedTurns, user } from './fake-session.mjs';
import { beforeSeq, itemsOf } from '../src/history.mjs';
import { buildReplay } from '../src/replay.mjs';

async function seeded(count = 3) {
  const session = new FakeSession();
  const snapshot = new MemorySnapshot({ 'a.txt': 'a1' });
  const turns = await seedTurns(session, snapshot, count);
  return { session, snapshot, turns };
}

/** Append replay events exactly as the runtime does, then close the turn. */
function apply(session, prepared, turn) {
  for (const event of prepared) {
    const options = {};
    if (event.surfaceOp !== undefined) options.surfaceOp = event.surfaceOp;
    if (event.sourceEventSeqs) options.sourceEventSeqs = event.sourceEventSeqs;
    session.append(event.type, event.data, options);
  }
  session.append('turn/end', { turn, reason: { kind: 'blocked' } });
  // A reload must accept the log the runtime just produced.
  return new FakeSession({ log: session.snapshotEvents() });
}

const texts = (session) =>
  itemsOf(session).map((item) => {
    const message = item.type === 'user/message' ? item.data : item.data.message;
    return message.content?.[0]?.text ?? '';
  });

test('undo replay hides the tail inside the borrowed turn', async () => {
  const { session, turns } = await seeded(3);
  const lastNode = session.surface.nodes.at(-1);
  const desired = beforeSeq(session, turns[1].userSeq, { createDetached: detached });
  session.append('turn/start', { turn: 4 });

  const { events, hidden } = buildReplay(session, desired, { turn: 4, step: 1, createDetached: detached });
  assert.deepEqual(hidden, { start: turns[1].userSeq, end: lastNode });
  assert.deepEqual(
    events.map((event) => event.type),
    ['step/start', 'developer/message', 'step/end'],
  );

  const reloaded = apply(session, events, 4);
  assert.deepEqual(texts(reloaded), ['message 1', 'answer 1']);
});

test('redo replay copies the tail with fresh identities', async () => {
  const { session, turns } = await seeded(3);
  // First rewind to just after turn 1, as an undo would.
  const rewind = beforeSeq(session, turns[1].userSeq, { createDetached: detached });
  session.append('turn/start', { turn: 4 });
  apply(session, buildReplay(session, rewind, { turn: 4, step: 1, createDetached: detached }).events, 4);

  // Now replay turns 1-2 back: the first turn is a common prefix, the rest is copied.
  const desired = beforeSeq(session, turns[2].userSeq, { createDetached: detached });
  session.append('turn/start', { turn: 5 });
  const { events } = buildReplay(session, desired, { turn: 5, step: 1, createDetached: detached });
  assert.deepEqual(
    events.map((event) => event.type),
    ['step/start', 'developer/message', 'user/message', 'assistant/message', 'step/end'],
  );
  const copyUser = events.find((event) => event.type === 'user/message');
  assert.notEqual(copyUser.data.id, 'm2');
  const copyAssistant = events.find((event) => event.type === 'assistant/message');
  assert.equal(copyAssistant.data.usage, undefined);
  assert.deepEqual(copyAssistant.data.stream, []);

  const reloaded = apply(session, events, 5);
  assert.deepEqual(texts(reloaded), ['message 1', 'answer 1', 'message 2', 'answer 2']);
});

test('replay copies get fresh tool-call ids and keep the pair', async () => {
  const source = new FakeSession();
  source.append('turn/start', { turn: 1 });
  source.append('step/start', { turn: 1, step: 1 });
  source.append('user/message', user('m1', 'read it'), { surfaceOp: 'append' });
  source.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      usage: { input: 10, output: 5 },
      stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: 'reading' } }],
      message: {
        ...assistant('a1'),
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }],
      },
    },
    { surfaceOp: 'append' },
  );
  source.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' });
  source.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: 't1',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'file body' }],
      },
    },
    { surfaceOp: 'append' },
  );
  source.append('step/end', { turn: 1, step: 1 });
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  // Replay the tool turn into an empty session, as a redo would.
  const desired = itemsOf(source);
  assert.equal(desired.length, 3);
  const target = new FakeSession();
  target.append('turn/start', { turn: 1 });
  const { events } = buildReplay(target, desired, { turn: 1, step: 1, createDetached: detached });

  const types = events.map((event) => event.type);
  assert.ok(types.includes('tool/call'), 'the replayed call needs its lifecycle row');
  const copy = events.find(
    (event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'tool-call'),
  );
  const callId = copy.data.message.content[0].id;
  assert.notEqual(callId, 'call-1');
  assert.equal(copy.data.usage, undefined);
  assert.deepEqual(copy.data.stream, []);
  const result = events.find((event) => event.type === 'tool/result');
  assert.equal(result.data.message.toolCallId, callId);
  assert.equal(result.data.message.source.callId, callId);
  assert.notEqual(result.data.message.id, 't1');

  const reloaded = apply(target, events, 1);
  assert.equal(itemsOf(reloaded).length, 3);
});

test('replay refuses a tool result without its call', async () => {
  const { session } = await seeded(1);
  session.append('turn/start', { turn: 2 });
  const desired = [
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { id: 't1', role: 'tool', source: { kind: 'tool', callId: 'ghost' }, toolCallId: 'ghost', content: [] },
      },
      source: 5,
    },
  ];
  assert.throws(() => buildReplay(session, desired, { turn: 2, step: 1, createDetached: detached }), /工具调用/);
});

test('an empty target still produces a legal turn', async () => {
  const { session } = await seeded(2);
  session.append('turn/start', { turn: 3 });
  const { events } = buildReplay(session, [], { turn: 3, step: 1, createDetached: detached });
  assert.deepEqual(
    events.map((event) => event.type),
    ['step/start', 'developer/message', 'step/end'],
  );
  const reloaded = apply(session, events, 3);
  // Only the empty hide marker remains on the surface; it is not conversation.
  assert.equal(reloaded.surface.nodes.length, 1);
  assert.deepEqual(itemsOf(reloaded), []);
});
