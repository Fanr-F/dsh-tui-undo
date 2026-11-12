import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from '../src/commands.mjs';

function fakeRuntime(overrides = {}) {
  const calls = [];
  return {
    calls,
    targets: async () => [
      { messageID: 'm1', seq: 1, text: 'first question', hidden: { turns: 2, events: 8 } },
      { messageID: 'm2', seq: 3, text: 'second question', hidden: { turns: 1, events: 4 } },
    ],
    undo: async (args) => {
      calls.push(['undo', args]);
      return { done: true, hidden: { turns: 1 }, files: [{ file: 'a.txt' }], restore: { failed: [] } };
    },
    redo: async (args) => {
      calls.push(['redo', args]);
      return { done: true, cleared: true };
    },
    status: async () => ({ redoAvailable: true, revert: { messageID: 'm1' } }),
    ...overrides,
  };
}

function fakeDialogs(answers) {
  const asked = [];
  let index = 0;
  return {
    asked,
    async select(request) {
      asked.push(['select', request.title]);
      const value = answers[index++];
      return value;
    },
    async confirm(request) {
      asked.push(['confirm', request.title]);
      const value = answers[index++];
      return value;
    },
  };
}

const invocation = { agent: { session: { id: 'session-1' } }, signal: undefined };

test('picking a target applies the undo immediately, with files', async () => {
  const runtime = fakeRuntime();
  const dialogs = fakeDialogs(['3']);
  const commands = createCommands({ runtime, dialogs: () => dialogs });

  const result = await commands.undo(invocation);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已回退到「second question」之前/);
  assert.match(result.text, /文件 1 个/);
  assert.deepEqual(dialogs.asked, [['select', '回退到哪条消息之前？']]);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.calls[0][1], { session: invocation.agent.session, seq: 3, files: true });
});

test('a cancelled target dialog changes nothing', async () => {
  const runtime = fakeRuntime();
  const commands = createCommands({ runtime, dialogs: () => fakeDialogs([undefined]) });
  assert.deepEqual(await commands.undo(invocation), { kind: 'success', text: '' });
  assert.equal(runtime.calls.length, 0);
});

test('without git the result says files were left alone', async () => {
  const runtime = fakeRuntime({
    undo: async (args) => {
      runtime.calls.push(['undo', args]);
      return { done: true, hidden: { turns: 1 }, files: [], restore: undefined, filesSkipped: true };
    },
  });
  const commands = createCommands({ runtime, dialogs: () => fakeDialogs(['3']) });
  const result = await commands.undo(invocation);
  assert.match(result.text, /未找到 git，文件未改动/);
});

test('undo without targets explains why instead of opening a dialog', async () => {
  const runtime = fakeRuntime({ targets: async () => [] });
  const dialogs = fakeDialogs([]);
  const commands = createCommands({ runtime, dialogs: () => dialogs });
  const result = await commands.undo(invocation);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /还没有可回退/);
  assert.deepEqual(dialogs.asked, []);
});

test('redo reports a completed rewind to the head', async () => {
  const runtime = fakeRuntime();
  const dialogs = fakeDialogs([true]);
  const commands = createCommands({ runtime, dialogs: () => dialogs });
  const result = await commands.redo(invocation);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已重做到最新/);
  assert.equal(runtime.calls[0][0], 'redo');
});

test('redo without a revert fails before asking', async () => {
  const runtime = fakeRuntime({ status: async () => ({ redoAvailable: false, revert: null }) });
  const dialogs = fakeDialogs([]);
  const commands = createCommands({ runtime, dialogs: () => dialogs });
  const result = await commands.redo(invocation);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /没有可重做/);
  assert.deepEqual(dialogs.asked, []);
});

test('a failure in the runtime becomes a command error, not a crash', async () => {
  const runtime = fakeRuntime({
    undo: async () => {
      throw new Error('另一会话正在回退');
    },
  });
  const commands = createCommands({ runtime, dialogs: () => fakeDialogs(['3']) });
  const result = await commands.undo(invocation);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /另一会话正在回退/);
});

test('a missing dialog service is reported', async () => {
  const runtime = fakeRuntime();
  const commands = createCommands({ runtime, dialogs: () => undefined });
  const result = await commands.undo(invocation);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /对话框服务不可用/);
});
