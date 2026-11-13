import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The web client half is a browser module, but its logic is plain JavaScript:
 * a fake `window.__ModuleLoader__`, a fake React and a fake slot ledger fully
 * exercise the row filtering without a browser.
 */

const loaded = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded.set(id, factory);
    },
  },
};

await import('../lib/client.js');

const factory = loaded.get('dsh-tui-undo');
assert.ok(factory, 'the module registered itself with the client loader');

const react = createReact();
const load = () => factory((name) => (name === 'react' ? react : undefined));

/** React stand-in: hooks run inline, elements are plain descriptors. */
function createReact() {
  return {
    createElement: (type, props) => ({ type, props }),
    useEffect: (run) => run(),
    useSyncExternalStore: (subscribe, read) => read(),
  };
}

/** Slot ledger with the host's `single` semantics: lowest priority renders. */
function createSlots() {
  const entries = [{ options: { priority: 0 }, component: () => 'original' }];
  const listeners = new Set();
  const disposers = [];
  const slots = {
    entries: () => [...entries],
    subscribe: (_name, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: (options, component) => {
      const priority = options.priority ?? 0;
      if (entries.some((entry) => (entry.options.priority ?? 0) === priority)) {
        throw new Error(`single slot "${options.name}" already has a registration at priority ${priority}`);
      }
      const entry = { options, component };
      entries.push(entry);
      for (const listener of listeners) listener();
      const dispose = () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        for (const listener of listeners) listener();
      };
      disposers.push(dispose);
      return dispose;
    },
  };
  return { slots, entries, listeners };
}

function createContext() {
  const cleanups = [];
  const { slots, entries, listeners } = createSlots();
  return {
    ctx: {
      slots,
      sessions: { binding: () => undefined },
      effect: (run) => {
        const dispose = run();
        if (typeof dispose === 'function') cleanups.push(dispose);
      },
    },
    entries,
    listeners,
    dispose: () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    },
  };
}

const node = (seq) => ({ anchorSeq: seq, data: { seq } });
const nodesOf = (pairs) => new Map(pairs.map(([key, seq]) => [key, node(seq)]));

test('the client module declares its services and applies', () => {
  const module = load();
  assert.equal(module.name, 'dsh-tui-undo-client');
  assert.deepEqual(module.inject, ['slots', 'sessions']);
  assert.equal(typeof module.apply, 'function');
});

test('applying swaps the chat flow component and restores it on dispose', () => {
  const module = load();
  const { ctx, entries, dispose } = createContext();
  const original = entries[0].component;
  module.apply(ctx);
  assert.equal(entries.length, 2, 'a probe registration publishes the swap');
  assert.notEqual(entries[0].component, original);
  assert.equal(entries[0].component.__dshTuiUndoFlow, true);
  dispose();
  assert.equal(entries[0].component, original);
});

test('hidden ranges remove the replayed rows from the flow', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ revision: 2, hiddenRanges: [{ start: 5, end: 9 }], undoAvailable: true, redoAvailable: false }),
  });
  const module = load();
  const { ctx, entries, dispose } = createContext();
  module.apply(ctx);
  const Flow = entries[0].component;

  const nodes = nodesOf([
    ['a', 3],
    ['b', 7],
    ['c', 11],
  ]);
  const props = {
    sessionId: 's1',
    entries: [
      { kind: 'node', key: 'a' },
      { kind: 'node', key: 'b' },
      { kind: 'node', key: 'c' },
      { kind: 'group', key: 'g' },
    ],
    useChat: (selector) => selector({ nodes }),
    useChatGroup: (_key, selector) => selector({ members: [{ key: 'a' }, { key: 'b' }] }),
  };

  // The first render has no state yet; the effect fetches it.
  Flow(props);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rendered = Flow(props);

  assert.equal(rendered.props.entries.length, 3, 'the hidden node row is dropped');
  assert.deepEqual(
    rendered.props.entries.map((entry) => entry.key),
    ['a', 'c', 'g'],
  );
  assert.deepEqual(rendered.props.useChatGroup('g', (group) => group).members.map((member) => member.key), ['a']);
  assert.equal(rendered.props.useChat, props.useChat, 'other props pass through');
  dispose();
});

test('an unknown session renders the original flow unchanged', async () => {
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'missing' }) });
  const module = load();
  const { ctx, entries, dispose } = createContext();
  module.apply(ctx);
  const Flow = entries[0].component;
  const props = {
    sessionId: 's1',
    entries: [{ kind: 'node', key: 'a' }],
    useChat: (selector) => selector({ nodes: nodesOf([['a', 3]]) }),
  };
  const rendered = Flow(props);
  assert.equal(rendered.props.entries, props.entries);
  dispose();
});
