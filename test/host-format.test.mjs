/**
 * The v6 acceptance test, run against the *installed* dsh.
 *
 * A fake session can only prove our own bookkeeping; this one hands the replay
 * to `@deepseek-ai/dsh-session` and its strict v3→v4 format catalog — the same
 * code that refuses to open a corrupt session — and asserts that the log the
 * plugin would write still loads, while the v5 shape is rejected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHost } from '../src/host.mjs';
import { beforeSeq, itemsOf } from '../src/history.mjs';
import { buildReplay } from '../src/replay.mjs';

let host;
try {
  host = await loadHost({ logger: { warn() {} } });
} catch (error) {
  host = { available: false, reason: error.message };
}
const skip = host.available ? false : `host session module unavailable: ${host.reason}`;

const header = () => ({ version: 4, id: 'format-check', createdAt: Date.now(), isSeeded: false, cwd: process.cwd() });
const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const assistant = (id, text) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'test', model: 'test' },
  content: [{ type: 'text', text }],
});

function seed(turns = 3) {
  const session = host.Session.create('format-check', [], header(), 0, []);
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step: 1 });
    session.append('user/message', user(`m${turn}`, `msg ${turn}`), { surfaceOp: 'append' });
    session.append(
      'assistant/message',
      { turn, step: 1, message: assistant(`a${turn}`, `ans ${turn}`), stream: [], usage: { input: 1, output: 1 } },
      { surfaceOp: 'append' },
    );
    session.append('step/end', { turn, step: 1 });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return session;
}

function appendReplay(session, events) {
  for (const event of events) {
    const options = {};
    if (event.surfaceOp !== undefined) options.surfaceOp = event.surfaceOp;
    if (event.sourceEventSeqs) options.sourceEventSeqs = event.sourceEventSeqs;
    session.append(event.type, event.data, options);
  }
}

test('a maintenance-turn replay reloads through the real format catalog', { skip }, () => {
  const session = seed(3);
  const targets = itemsOf(session).filter((item) => item.type === 'user/message');
  assert.equal(targets.length, 3);

  const desired = beforeSeq(session, targets[1].source, { createDetached: host.createDetached });
  session.append('turn/start', { turn: 4 });
  const { events } = buildReplay(session, desired, {
    turn: 4,
    step: 1,
    createDetached: host.createDetached,
    validate: host.validate,
  });
  appendReplay(session, events);
  // The host loop appends turn/end itself, after the plugin's events.
  session.append('turn/end', { turn: 4, reason: { kind: 'blocked' } });

  assert.doesNotThrow(() => host.validate(session));
  const reopened = host.Session.create('format-check', session.snapshotEvents(), header(), 0, []);
  assert.deepEqual(
    itemsOf(reopened).map((item) => (item.type === 'user/message' ? item.data.content[0].text : item.data.message.content[0].text)),
    ['msg 1', 'ans 1'],
  );
});

test('a redo replay reloads through the real format catalog', { skip }, () => {
  const session = seed(3);
  const targets = itemsOf(session).filter((item) => item.type === 'user/message');

  // Undo to the second turn, then replay the second turn back (a redo).
  const first = beforeSeq(session, targets[1].source, { createDetached: host.createDetached });
  session.append('turn/start', { turn: 4 });
  appendReplay(
    session,
    buildReplay(session, first, { turn: 4, step: 1, createDetached: host.createDetached, validate: host.validate }).events,
  );
  session.append('turn/end', { turn: 4, reason: { kind: 'blocked' } });

  const second = beforeSeq(session, targets[2].source, { createDetached: host.createDetached });
  session.append('turn/start', { turn: 5 });
  appendReplay(
    session,
    buildReplay(session, second, { turn: 5, step: 1, createDetached: host.createDetached, validate: host.validate }).events,
  );
  session.append('turn/end', { turn: 5, reason: { kind: 'blocked' } });

  assert.doesNotThrow(() => host.validate(session));
  const reopened = host.Session.create('format-check', session.snapshotEvents(), header(), 0, []);
  assert.equal(itemsOf(reopened).length, 4);
});

test('v5 shape — a message appended after turn/end — is rejected', { skip }, () => {
  const session = seed(1);
  session.append('developer/message', {
    turn: 1,
    step: 1,
    message: { id: 'hide', role: 'developer', source: { kind: 'dsh-tui-undo' }, content: [] },
  }, { surfaceOp: 'append' });
  assert.throws(() => host.validate(session), /turn and step|corrupt/i);
});
