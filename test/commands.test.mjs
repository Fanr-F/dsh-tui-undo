import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from '../src/commands.mjs';

const targets = [
  { seq: 10, label: 'first message', text: 'first message' },
  { seq: 20, label: 'second message', text: 'second message' },
  { seq: 30, label: 'third message', text: 'third message' },
];

function fakeRuntime(overrides = {}) {
  const calls = { undo: [], redo: 0 };
  const runtime = {
    targets: async () => targets,
    undo: async ({ seq }) => {
      calls.undo.push(seq);
      return { files: 2, restored: { failed: [] } };
    },
    redo: async () => {
      calls.redo += 1;
      return { files: 1, restored: { failed: [] } };
    },
    ...overrides,
  };
  return { runtime, calls };
}

const invocation = (input, extra = {}) => ({ agent: { session: { id: 's1' } }, input, signal: undefined, ...extra });

test('/undo without an argument lists the candidates and changes nothing', async () => {
  const { runtime, calls } = fakeRuntime();
  const commands = createCommands({ runtime, dialogs: () => undefined });
  const result = await commands.undo(invocation(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /可回退到以下消息之前/);
  // Newest first, and the conversation's first message is not offered.
  assert.match(result.text, /1\. third message/);
  assert.match(result.text, /2\. second message/);
  assert.doesNotMatch(result.text, /first message/);
  assert.deepEqual(calls.undo, []);
});

test('/undo <n> applies the chosen target immediately', async () => {
  const { runtime, calls } = fakeRuntime();
  const commands = createCommands({ runtime, dialogs: () => undefined });
  const result = await commands.undo(invocation('2'));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已回退到「second message」之前/);
  assert.deepEqual(calls.undo, [20]);
});

test('/undo with an out-of-range index explains and lists again', async () => {
  const { runtime } = fakeRuntime();
  const commands = createCommands({ runtime, dialogs: () => undefined });
  const result = await commands.undo(invocation('9'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /没有第 9 条/);
  assert.match(result.text, /可回退到以下消息之前/);
});

test('/undo uses the picker when the host provides dialogs', async () => {
  const { runtime, calls } = fakeRuntime();
  const selected = [];
  const commands = createCommands({
    runtime,
    dialogs: () => ({
      select: async (request) => {
        selected.push(request);
        return '2';
      },
    }),
  });
  const result = await commands.undo(invocation(''));
  assert.equal(selected.length, 1);
  assert.equal(result.kind, 'success');
  assert.deepEqual(calls.undo, [20]);
});

test('/undo cancels silently when the picker is dismissed', async () => {
  const { runtime, calls } = fakeRuntime();
  const commands = createCommands({ runtime, dialogs: () => ({ select: async () => undefined }) });
  const result = await commands.undo(invocation(''));
  assert.deepEqual(result, { kind: 'success', text: '' });
  assert.deepEqual(calls.undo, []);
});

test('undo and redo report failures as text', async () => {
  const { runtime } = fakeRuntime({
    undo: async () => {
      throw new Error('工作区忙');
    },
    redo: async () => {
      throw new Error('没有可重做的撤回');
    },
  });
  const commands = createCommands({ runtime, dialogs: () => undefined });
  assert.deepEqual(await commands.undo(invocation('1')), { kind: 'error', text: '工作区忙' });
  assert.deepEqual(await commands.redo(invocation('')), { kind: 'error', text: '没有可重做的撤回' });
});

test('/redo applies the last rewind', async () => {
  const { runtime, calls } = fakeRuntime();
  const commands = createCommands({ runtime, dialogs: () => undefined });
  const result = await commands.redo(invocation(''));
  assert.equal(result.kind, 'success');
  assert.equal(calls.redo, 1);
});
