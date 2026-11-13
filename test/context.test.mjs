import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextLog, describeInput, describeMessage } from '../src/context.mjs';

const message = (role, text) => ({ role, content: [{ type: 'text', text }] });

test('describeInput keeps roles, character counts and a clipped body', () => {
  const described = describeInput(
    [
      message('system', 'x'.repeat(50)),
      message('user', 'hello'),
      { role: 'assistant', content: [{ type: 'tool-call', name: 'bash', arguments: { command: 'ls' } }] },
      { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] },
    ],
    { limit: 40 },
  );
  assert.equal(described.count, 4);
  assert.deepEqual(described.roles, ['system', 'user', 'assistant', 'tool']);
  assert.equal(described.messages[0].text.length, 40, 'the body is clipped to the limit');
  assert.match(described.messages[2].text, /tool-call bash/);
  assert.match(described.messages[3].text, /ok/);
  assert.equal(described.chars, described.messages.reduce((total, item) => total + item.chars, 0));
  assert.equal(describeMessage({ role: 'user', content: 'abcdefghij' }, { limit: 5 }).text, 'abcd…');
});

test('describeMessage accepts string content and missing content', () => {
  assert.equal(describeMessage({ role: 'user', content: 'plain' }).text, 'plain');
  assert.deepEqual(describeMessage({ role: 'user' }), { role: 'user', chars: 0, text: '' });
});

test('the context log keeps one JSONL file per session and reads the last record back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undo-context-'));
  try {
    const log = createContextLog({ directory });
    assert.ok(log.pathOf('session-a').startsWith(directory));
    assert.notEqual(log.pathOf('session-a'), log.pathOf('session-b'));

    const record = (at, text) => ({
      at,
      turn: at,
      seq: at * 2,
      count: 1,
      chars: text.length,
      roles: ['user'],
      messages: [{ role: 'user', chars: text.length, text }],
    });
    await log.write('session-a', record(1, 'abc'));
    await log.write('session-a', record(2, 'def'));

    assert.equal((await log.last('session-a')).messages[0].text, 'def');
    assert.equal(await log.last('session-b'), null);

    // A fresh instance (a restarted host) reads the same file.
    const reopened = createContextLog({ directory });
    assert.equal((await reopened.last('session-a')).turn, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
