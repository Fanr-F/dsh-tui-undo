import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSession, MemorySnapshot, detached, seedTurns } from './fake-session.mjs';
import { beforeSeq, commonPrefix, hidden, itemsOf, mergeRanges, userTargets } from '../src/history.mjs';

async function seeded(count = 3) {
  const session = new FakeSession();
  const snapshot = new MemorySnapshot({ 'a.txt': 'a1' });
  const turns = await seedTurns(session, snapshot, count);
  return { session, snapshot, turns };
}

test('itemsOf folds the surface and drops replayed usage', async () => {
  const { session } = await seeded(2);
  const items = itemsOf(session);
  assert.deepEqual(
    items.map((item) => item.type),
    ['user/message', 'assistant/message', 'user/message', 'assistant/message'],
  );
  assert.deepEqual(
    items.map((item) => item.source),
    [2, 3, 8, 9],
  );
  assert.equal(items[1].data.usage, undefined);
  assert.deepEqual(items[1].data.stream, []);
});

test('beforeSeq folds only the prefix of the log', async () => {
  const { session, turns } = await seeded(3);
  const items = beforeSeq(session, turns[1].userSeq, { createDetached: detached });
  assert.deepEqual(
    items.map((item) => item.source),
    [2, 3],
  );
  const empty = beforeSeq(session, 2, { createDetached: detached });
  assert.deepEqual(empty, []);
});

test('beforeSeq rejects a cut past the log', async () => {
  const { session } = await seeded(1);
  assert.throws(() => beforeSeq(session, session.seq + 5, { createDetached: detached }), /past the end/);
  assert.throws(() => beforeSeq(session, 0, {}), /detached session factory/);
});

test('commonPrefix compares messages without their identity', async () => {
  const { session, turns } = await seeded(2);
  const all = itemsOf(session);
  const prefix = beforeSeq(session, turns[1].userSeq, { createDetached: detached });
  assert.equal(commonPrefix(prefix, all), 2);
  assert.equal(commonPrefix(all, all), all.length);
  // Identity alone is not a difference: a copied message keeps its place.
  const renamed = structuredClone(all);
  renamed[0].data.id = 'different-id';
  assert.equal(commonPrefix(renamed, all), all.length);
  // Changed content is.
  const edited = structuredClone(all);
  edited[1].data.message.content = [{ type: 'text', text: 'changed' }];
  assert.equal(commonPrefix(edited, all), 1);
});

test('userTargets exposes only human messages, with their text', async () => {
  const { session, turns } = await seeded(3);
  const targets = userTargets(session);
  assert.deepEqual(
    targets.map((target) => target.seq),
    turns.map((turn) => turn.userSeq),
  );
  assert.equal(targets[1].text, 'message 2');
});

test('mergeRanges coalesces touching and overlapping ranges', () => {
  assert.deepEqual(
    mergeRanges([
      { start: 5, end: 6 },
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 10, end: 12 },
    ]),
    [
      { start: 1, end: 6 },
      { start: 10, end: 12 },
    ],
  );
  assert.equal(hidden([{ start: 3, end: 6 }], 4), true);
  assert.equal(hidden([{ start: 3, end: 6 }], 7), false);
  assert.equal(hidden(undefined, 1), false);
});
