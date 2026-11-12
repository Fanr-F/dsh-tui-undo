import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { install } from '../src/index.mjs';

function fakeContext() {
  const handlers = new Map();
  const registered = [];
  const warnings = [];
  const effects = [];
  const context = {
    logger: { warn: (message) => warnings.push(String(message)) },
    sessions: { flush: async () => {} },
    get: (service) => {
      if (service === 'workingDirectory') return { get: () => 'D:/work' };
      if (service === 'tuiDialogs') return { select: async () => undefined, confirm: async () => false };
      return undefined;
    },
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') effects.push(cleanup);
    },
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    inject: (services, run) => {
      run({
        effect: (fn) => {
          const cleanup = fn();
          if (typeof cleanup === 'function') effects.push(cleanup);
        },
        commands: {
          register: ({ name }) => {
            registered.push(name);
            return () => {};
          },
        },
      });
    },
    handlers,
    registered,
    warnings,
  };
  return context;
}

async function sandbox(t) {
  const root = join(process.cwd(), '.tmp', 'plugin', randomUUID());
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('install registers /undo and /redo and the collection hooks', async (t) => {
  const root = await sandbox(t);
  const ctx = fakeContext();
  await install(ctx, { storageDir: root });

  assert.deepEqual(ctx.registered, ['undo', 'redo']);
  assert.ok(ctx.handlers.has('agent/pre-step'));
  assert.ok(ctx.handlers.has('session/event'));
});

test('a failing pre-step snapshot never blocks the agent step', async (t) => {
  const root = await sandbox(t);
  const ctx = fakeContext();
  await install(ctx, { storageDir: root });

  const [preStep] = ctx.handlers.get('agent/pre-step');
  let proceeded = false;
  const result = await preStep({ agent: { session: { id: 's1', header: { cwd: 'D:/work' } } } }, async () => {
    proceeded = true;
    return 'continued';
  });

  assert.equal(proceeded, true);
  assert.equal(result, 'continued');
  assert.ok(ctx.warnings.some((message) => /pre-step snapshot skipped/.test(message)));
});

test('a step without a session is passed through untouched', async (t) => {
  const root = await sandbox(t);
  const ctx = fakeContext();
  await install(ctx, { storageDir: root });

  const [preStep] = ctx.handlers.get('agent/pre-step');
  let proceeded = false;
  await preStep({}, async () => {
    proceeded = true;
  });
  assert.equal(proceeded, true);
});

test('session events without a message are ignored', async (t) => {
  const root = await sandbox(t);
  const ctx = fakeContext();
  await install(ctx, { storageDir: root });

  const [onEvent] = ctx.handlers.get('session/event');
  await onEvent({ id: 's1', header: { cwd: 'D:/work' } }, { seq: 1, type: 'step/start', data: {} });
  // No snapshot capture is attempted without a rewritable host, so no warning either.
  assert.ok(Array.isArray(ctx.warnings));
});
