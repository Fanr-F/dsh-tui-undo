import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteForReplay } from '../src/replay.mjs';
import { hideFrom, showCopies, surfaceNodes } from '../src/surface.mjs';
import { FakeSession, user } from './fake-session.mjs';

const toolTurn = () => [
  { seq: 0, type: 'user/message', data: user('u1', 'go') },
  {
    seq: 1,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
      },
      stream: [
        { type: 'tool-call-chunks', time0: 0, index: 0, dt: [0], id: 'call-1', name: 'read', args: ['{}'] },
        { type: 'chunk', time: 2, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '{}' } },
      ],
    },
  },
  {
    seq: 2,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'r1',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: 'ok' }],
        toolCallId: 'call-1',
      },
    },
  },
];

function counter() {
  let n = 0;
  return () => `new-${(n += 1)}`;
}

test('every copied message gets a fresh id and originals stay untouched', () => {
  const events = toolTurn();
  const before = structuredClone(events);
  const { events: prepared, messages, calls } = rewriteForReplay(events, { newId: counter() });

  assert.equal(prepared.length, 3);
  assert.deepEqual(prepared.map((event) => event.originSeq), [0, 1, 2]);
  assert.notEqual(prepared[0].data.id, 'u1');
  assert.notEqual(prepared[1].data.message.id, 'a1');
  assert.notEqual(prepared[2].data.message.id, 'r1');
  assert.equal(new Set([prepared[0].data.id, prepared[1].data.message.id, prepared[2].data.message.id]).size, 3);

  assert.equal(messages.get(0), 'u1');
  assert.equal(messages.get(1), 'a1');
  assert.equal(messages.get(2), 'r1');
  assert.ok(calls.has('call-1'));

  assert.deepEqual(events, before, 'the originals are never mutated');
});

test('tool calls stay paired with their results after the rewrite', () => {
  const { events: prepared, calls } = rewriteForReplay(toolTurn(), { newId: counter() });
  const [, assistant, result] = prepared;
  const nextCall = assistant.data.message.content[0].id;

  assert.notEqual(nextCall, 'call-1');
  assert.equal(calls.get('call-1'), nextCall);
  assert.equal(assistant.data.stream[0].id, nextCall);
  assert.equal(assistant.data.stream[1].chunk.id, nextCall);
  assert.equal(result.data.message.toolCallId, nextCall);
  assert.equal(result.data.message.source.callId, nextCall);
});

test('copied turns move into the replay namespace and drop usage', () => {
  const events = toolTurn();
  events[1].data.usage = { input: 10, output: 5 };
  const { events: prepared } = rewriteForReplay(events, { newId: counter(), turnBase: 2_000_000 });

  assert.equal(prepared[1].data.turn, 2_000_000);
  assert.equal(prepared[2].data.turn, 2_000_000);
  assert.equal(prepared[1].data.usage, undefined);
});

test('a tool result without its call in the segment still gets a usable id', () => {
  const orphan = [toolTurn()[2]];
  const { events: prepared } = rewriteForReplay(orphan, { newId: counter() });
  const callId = prepared[0].data.message.toolCallId;
  assert.match(callId, /^new-/);
  assert.equal(prepared[0].data.message.source.callId, callId);
});

test('showCopies({ rewrite: true }) appends the rewritten ids to the surface', () => {
  const session = new FakeSession();
  const events = toolTurn().map((event) => session.append(event.type, event.data, { surfaceOp: 'append' }));
  hideFrom(session, { startSeq: 0 });

  const copies = showCopies(session, events, { rewrite: true, newId: counter() });
  assert.deepEqual(surfaceNodes(session), [3, 4, 5, 6]);
  assert.equal(copies.length, 3);
  assert.notEqual(copies[0].data.id, 'u1');
  assert.equal(copies[2].data.message.toolCallId, copies[1].data.message.content[0].id);
  assert.equal(copies[1].data.message.content[0].id, 'new-3');
});
