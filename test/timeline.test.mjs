import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundaryFor,
  lastBoundary,
  nextBoundary,
  plan,
  touchedFiles,
  userMessages,
} from '../src/timeline.mjs';

const T0 = '0'.repeat(40);
const T1 = '1'.repeat(40);
const T2 = '2'.repeat(40);
const T3 = '3'.repeat(40);

const user = (seq, id) => ({ seq, type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: id }] } });
const assistant = (seq, snapshot) => ({ seq, type: 'assistant/message', data: { id: `a${seq}`, snapshot } });

// a1 -> a2 -> a3, one assistant step per turn.
const turns = [
  user(1, 'm1'),
  assistant(2, { start: T0, end: T1, files: ['a.txt'] }),
  user(3, 'm2'),
  assistant(4, { start: T1, end: T2, files: ['a.txt', 'b.txt'] }),
  user(5, 'm3'),
  assistant(6, { start: T2, end: T3, files: ['a.txt'] }),
];
const snapshots = Object.fromEntries(turns.filter((event) => event.data?.snapshot).map((event) => [event.seq, event.data.snapshot]));

test('plan maps each file to the first step that touched it after the boundary', () => {
  assert.deepEqual(
    [...plan({ timeline: turns, snapshots, boundarySeq: 1 })].sort(),
    [
      ['a.txt', T0],
      ['b.txt', T1],
    ],
  );
  assert.deepEqual([...plan({ timeline: turns, snapshots, boundarySeq: 3 })].sort(), [
    ['a.txt', T1],
    ['b.txt', T1],
  ]);
  assert.deepEqual([...plan({ timeline: turns, snapshots, boundarySeq: 5 })], [['a.txt', T2]]);
});

test('plan ignores steps without a captured start tree', () => {
  const timeline = [...turns, user(7, 'm4'), assistant(8, { end: T3, files: ['c.txt'] })];
  const withFiles = { ...snapshots, 8: { end: T3, files: ['c.txt'] } };
  assert.equal(plan({ timeline, snapshots: withFiles, boundarySeq: 5 }).has('c.txt'), false);
});

test('only human turns are undo targets', () => {
  const timeline = [...turns, { seq: 7, type: 'user/message', data: { id: 'tool', source: { kind: 'tool' } } }];
  assert.deepEqual(userMessages(timeline).map((event) => event.data.id), ['m1', 'm2', 'm3']);
  assert.equal(lastBoundary(timeline), 5);
  assert.equal(boundaryFor(timeline, 'm2'), 3);
  assert.equal(boundaryFor(timeline, 5), 5);
  assert.equal(boundaryFor(timeline, 'missing'), undefined);
});

test('redo walks the boundary forward, then stops', () => {
  assert.equal(nextBoundary(turns, 1), 3);
  assert.equal(nextBoundary(turns, 3), 5);
  assert.equal(nextBoundary(turns, 5), undefined);
});

test('touchedFiles lists each changed path once, in step order', () => {
  assert.deepEqual(touchedFiles({ timeline: turns, snapshots, boundarySeq: 1 }), ['a.txt', 'b.txt']);
});
