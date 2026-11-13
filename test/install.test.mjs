/**
 * Activation contract for a host without web services (dsh-tui).
 *
 * The plugin must mount, register its commands, and stay inert on the
 * web-only services. This fake context models a TUI composition: a `commands`
 * service, no `webServer`/`connection`, and a plain `sessions` service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { install } from '../src/index.mjs';
import { FakeSession } from './fake-session.mjs';

function fakeContext({ services = {} } = {}) {
  const commands = new Map();
  const effects = [];
  const listeners = new Map();
  const context = {
    logger: { info() {}, warn() {}, debug() {} },
    sessions: { messageProjections: [], flush: async () => {} },
    get: (name) => services[name],
    effect(run) {
      const dispose = run();
      if (typeof dispose === 'function') effects.push(dispose);
      return dispose;
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => {};
    },
    inject(names, callback) {
      if (!names.every((name) => services[name] !== undefined)) return () => {};
      const scope = {
        logger: context.logger,
        effect: context.effect,
        commands: {
          register(definition) {
            commands.set(definition.name, definition);
            return () => commands.delete(definition.name);
          },
        },
        webServer: services.webServer,
        connection: services.connection,
      };
      const dispose = callback(scope);
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
  };
  return { context, commands, effects, listeners };
}

const invocation = (session, input = '') => ({ agent: { session }, input, rawInput: input, signal: undefined });

test('a TUI-shaped host mounts the plugin and its commands', async () => {
  const { context, commands, listeners } = fakeContext({
    services: { commands: {} },
  });
  await install(context, { storageDir: 'D:\\tmp\\dsh-undo-install-test', log: false });

  assert.deepEqual([...commands.keys()].sort(), ['redo', 'undo', 'undo-status']);
  assert.equal(typeof listeners.get('agent/pre-step'), 'function');
  assert.equal(typeof listeners.get('session/event'), 'function');
});

test('/undo works on such a host without rewind state', async () => {
  const { context, commands } = fakeContext({ services: { commands: {} } });
  await install(context, { storageDir: 'D:\\tmp\\dsh-undo-install-test-2', log: false });

  const session = new FakeSession();
  const result = await commands.get('undo').handler(invocation(session));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /还没有可回退的用户消息/);
});

test('/redo reports the missing state instead of throwing', async () => {
  const { context, commands } = fakeContext({ services: { commands: {} } });
  await install(context, { storageDir: 'D:\\tmp\\dsh-undo-install-test-3', log: false });
  const result = await commands.get('redo').handler(invocation(new FakeSession()));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /没有可重做的撤回/);
});

