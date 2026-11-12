import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideFrom, isVisible, lastVisibleSeq, showCopies, showCopy, surfaceNodes, supportsBatchAppend, turnStep } from '../src/surface.mjs';

const SURFACE_ELIGIBLE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

/**
 * Encodes the rules the real host enforces (verified by scripts/verify-host.mjs):
 * surface events need a marker, replace ranges must be on the surface, and
 * `sourceEventSeqs` must cover every shadowed node.
 */
class FakeSession {
  constructor() {
    this.log = [];
    this.nodes = [];
  }

  get seq() {
    return this.log.length;
  }

  get surface() {
    return { nodes: this.nodes };
  }

  snapshotEvents() {
    return structuredClone(this.log);
  }

  /** Mimics dsh 0.2.2-rc.2's batch-append marker. */
  get currentBatchPublication() {
    return undefined;
  }

  append(typeOrInputs, data, opts = {}) {
    if (Array.isArray(typeOrInputs)) {
      return typeOrInputs.map(([type, payload, options]) => this.#commit(type, payload, options ?? {}));
    }
    return this.#commit(typeOrInputs, data, opts);
  }

  #commit(type, data, opts = {}) {
    const seq = this.log.length;
    if (SURFACE_ELIGIBLE.has(type)) {
      const op = opts.surfaceOp;
      if (op === undefined) throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`);
      if (op === 'append') {
        this.nodes.push(seq);
      } else {
        const start = this.nodes.indexOf(op.startSeq);
        const end = this.nodes.indexOf(op.endSeq);
        if (start === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
        if (end === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
        const covered = this.nodes.slice(start, end + 1);
        const sources = new Set(opts.sourceEventSeqs ?? []);
        const missing = covered.filter((node) => !sources.has(node));
        if (missing.length) throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
        this.nodes.splice(start, covered.length, seq);
      }
    }
    const event = { seq, type, data: structuredClone(data) };
    this.log.push(event);
    return event;
  }
}

function seeded() {
  const session = new FakeSession();
  session.append('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'one' }] }, { surfaceOp: 'append' });
  session.append('assistant/message', { message: { id: 'a1', role: 'assistant', content: [] }, stream: [] }, { surfaceOp: 'append' });
  session.append('user/message', { id: 'm2', role: 'user', content: [{ type: 'text', text: 'two' }] }, { surfaceOp: 'append' });
  return session;
}

test('hideFrom shadows the tail and keeps the earlier surface intact', () => {
  const session = seeded();
  assert.deepEqual(surfaceNodes(session), [0, 1, 2]);

  const hidden = hideFrom(session, { startSeq: 1 });
  assert.deepEqual(hidden, [1, 2]);
  assert.deepEqual(surfaceNodes(session), [0, 3]);
  assert.equal(lastVisibleSeq(session), 3);
  assert.equal(isVisible(session, 1), false);

  const logged = session.snapshotEvents().at(-1);
  assert.equal(logged.type, 'developer/message');
  assert.deepEqual(logged.data.content ?? [], []);
});

test('hideFrom is a no-op when nothing sits at or after the boundary', () => {
  const session = seeded();
  const before = session.seq;
  assert.equal(hideFrom(session, { startSeq: 99 }), undefined);
  assert.equal(session.seq, before);
});

test('a hidden event can only come back as a new copy', () => {
  const session = seeded();
  const hidden = session.snapshotEvents()[1];
  hideFrom(session, { startSeq: 1 });

  const copy = showCopy(session, hidden);
  assert.equal(copy.type, 'assistant/message');
  assert.ok(isVisible(session, copy.seq));
  // The original stays hidden; sequence numbers are never reused.
  assert.equal(isVisible(session, 1), false);
  assert.equal(copy.seq, 4);
});

test('showCopy refuses events that never belonged to the surface', () => {
  const session = seeded();
  session.append('turn/start', { turn: 1 }, {});
  assert.throws(() => showCopy(session, session.snapshotEvents().at(-1)), /not a surface event/);
});

test('turnStep reports the latest counters for the hiding message', () => {
  const session = seeded();
  session.append('turn/start', { turn: 3 }, {});
  session.append('step/start', { turn: 3, step: 2 }, {});
  assert.deepEqual(turnStep(session), { turn: 3, step: 2 });
});

test('rc.2 batch append is detected and used for multi-event redo', () => {
  const session = seeded();
  const hidden = session.snapshotEvents().slice(0, 2);
  hideFrom(session, { startSeq: 1 });
  assert.equal(supportsBatchAppend(session), true);

  const before = session.seq;
  const copies = showCopies(session, hidden);
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map((event) => event.seq), [before, before + 1]);
  assert.deepEqual(surfaceNodes(session), [0, 3, before, before + 1]);
});

test('without batch append every copy is appended on its own', () => {
  const session = seeded();
  // A rc.1-shaped session: same surface, no batch overload and no marker.
  const legacy = {
    get seq() {
      return session.seq;
    },
    get surface() {
      return session.surface;
    },
    snapshotEvents: () => session.snapshotEvents(),
    append: (type, data, opts) => session.append(type, data, opts),
  };
  assert.equal(supportsBatchAppend(legacy), false);

  const hidden = legacy.snapshotEvents().slice(0, 2);
  hideFrom(legacy, { startSeq: 1 });
  const copies = showCopies(legacy, hidden);
  assert.deepEqual(copies.map((event) => event.seq), [4, 5]);
  assert.deepEqual(surfaceNodes(legacy), [0, 3, 4, 5]);
});
