import { hideFrom, showCopies, surfaceNodes } from '../src/surface.mjs';

const ELIGIBLE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

/**
 * In-memory session that enforces the dsh 0.2.2-rc.2 surface contract
 * (verified by `scripts/verify-host.mjs`): surface events carry a marker,
 * replace ranges must name current nodes, `sourceEventSeqs` must cover every
 * shadowed node, and assistant copies may not cite sources.
 */
export class FakeSession {
  constructor({ failAppend = false } = {}) {
    this.log = [];
    this.nodes = [];
    this.replaceGeneration = 0;
    this.contentGeneration = 0;
    this.failAppend = failAppend;
    this.appends = 0;
  }

  get id() {
    return 'session-1';
  }

  get header() {
    return { cwd: 'D:/work' };
  }

  get seq() {
    return this.log.length;
  }

  get surface() {
    return {
      nodes: this.nodes,
      replaceGeneration: this.replaceGeneration,
      contentGeneration: this.contentGeneration,
    };
  }

  snapshotEvents() {
    return structuredClone(this.log);
  }

  /** Mimics rc.2's batch-append marker. */
  get currentBatchPublication() {
    return undefined;
  }

  append(typeOrInputs, data, opts = {}) {
    if (Array.isArray(typeOrInputs)) {
      if (this.failAppend) throw new Error('append rejected');
      return typeOrInputs.map(([type, payload, options]) => this.#commit(type, payload, options ?? {}));
    }
    if (this.failAppend) throw new Error('append rejected');
    return this.#commit(typeOrInputs, data, opts);
  }

  #commit(type, data, opts = {}) {
    this.appends += 1;
    const seq = this.log.length;
    if (ELIGIBLE.has(type)) {
      const op = opts.surfaceOp;
      if (op === undefined) throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`);
      if (op === 'append') {
        if (type === 'assistant/message' && opts.sourceEventSeqs !== undefined) {
          throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs');
        }
        this.nodes.push(seq);
      } else {
        const start = this.nodes.indexOf(op.startSeq);
        const end = this.nodes.indexOf(op.endSeq);
        if (start === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
        if (end === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
        if (start > end) throw new Error('surface replace: start is after end');
        const covered = this.nodes.slice(start, end + 1);
        const sources = new Set(opts.sourceEventSeqs ?? []);
        const missing = covered.filter((node) => !sources.has(node));
        if (missing.length) {
          throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
        }
        for (const source of sources) {
          if (!Number.isSafeInteger(source) || source >= seq) throw new Error('sourceEventSeqs must reference earlier events');
        }
        this.nodes.splice(start, covered.length, seq);
        this.replaceGeneration += 1;
        this.contentGeneration += 1;
      }
    } else if (opts.surfaceOp !== undefined) {
      throw new Error(`session event "${type}" is not surface-eligible and cannot carry surfaceOp`);
    }
    const event = { seq, time: seq + 1, type, data: structuredClone(data) };
    this.log.push(event);
    return structuredClone(event);
  }
}

/** The port `RevertService`/`RewindRuntime` drive on a live host. */
export function surfacePort(session) {
  return {
    id: session.id,
    header: () => session.header,
    events: () => structuredClone(session.snapshotEvents()),
    visible: () => surfaceNodes(session),
    generation: () => ({
      replaceGeneration: session.surface.replaceGeneration,
      contentGeneration: session.surface.contentGeneration,
    }),
    hideFrom: (startSeq) => hideFrom(session, { startSeq }),
    showCopies: (events, options) => showCopies(session, events, options),
  };
}

export class MemorySnapshot {
  constructor(files) {
    this.current = new Map(Object.entries(files));
    this.trees = new Map();
    this.counter = 0;
  }

  async capture() {
    const key = JSON.stringify([...this.current].sort());
    this.byContent ??= new Map();
    if (this.byContent.has(key)) return { tree: this.byContent.get(key), uncovered: [] };
    const tree = (this.counter += 1).toString(16).padStart(40, '0');
    this.trees.set(tree, new Map(this.current));
    this.byContent.set(key, tree);
    return { tree, uncovered: [] };
  }

  async restore(files) {
    for (const [file, tree] of files) {
      const snapshot = this.trees.get(tree);
      if (!snapshot) throw new Error(`missing tree ${tree}`);
      if (!snapshot.has(file)) this.current.delete(file);
      else this.current.set(file, snapshot.get(file));
    }
    return { restored: [], removed: [], failed: [] };
  }

  async files(from, to) {
    const before = this.trees.get(from);
    const after = this.trees.get(to);
    return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
  }

  async diff(from, to, { paths } = {}) {
    const before = this.trees.get(from);
    const after = this.trees.get(to);
    const files = paths ?? [...new Set([...before.keys(), ...after.keys()])];
    return files
      .filter((file) => before.get(file) !== after.get(file))
      .map((file) => ({
        file,
        status: before.has(file) ? (after.has(file) ? 'modified' : 'deleted') : 'added',
        additions: 1,
        deletions: 1,
        binary: false,
        patch: '',
      }));
  }
}

export const user = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: text === undefined ? [] : [{ type: 'text', text }],
});

export const assistant = (id) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'test', model: 'test' },
  content: [],
});

/**
 * Three turns that rewrite `a.txt` and create/keep `b.txt`.
 *
 * Surface-visible sequences are returned so tests never hard-code positions.
 */
export async function seedThreeTurns(session, snapshot) {
  const head = (await snapshot.capture()).tree;
  const turns = [];

  const startTurn = (turn, userID) => {
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step: 1 });
    const event = session.append('user/message', user(userID, userID), { surfaceOp: 'append' });
    return event.seq;
  };

  const endTurn = async (turn, start, files, messageID) => {
    const end = (await snapshot.capture()).tree;
    const event = session.append(
      'assistant/message',
      { turn, step: 1, message: assistant(messageID), stream: [], snapshot: { start, end, files } },
      { surfaceOp: 'append' },
    );
    return { seq: event.seq, start, end };
  };

  const m1 = startTurn(1, 'm1');
  snapshot.current.set('a.txt', 'a2');
  const step1 = await endTurn(1, head, ['a.txt'], 'a1');

  const m2 = startTurn(2, 'm2');
  snapshot.current.set('b.txt', 'b1');
  const step2 = await endTurn(2, step1.end, ['b.txt'], 'a2');

  const m3 = startTurn(3, 'm3');
  snapshot.current.set('a.txt', 'a3');
  const step3 = await endTurn(3, step2.end, ['a.txt'], 'a3');

  turns.push({ m1, m2, m3, steps: [step1, step2, step3] });
  return {
    head,
    m1,
    m2,
    m3,
    steps: [step1, step2, step3],
    snapshots: {
      [step1.seq]: { start: head, end: step1.end, files: ['a.txt'] },
      [step2.seq]: { start: step1.end, end: step2.end, files: ['b.txt'] },
      [step3.seq]: { start: step2.end, end: step3.end, files: ['a.txt'] },
    },
  };
}
