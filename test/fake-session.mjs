/**
 * In-memory stand-ins for the parts of dsh the runtime drives.
 *
 * `FakeSession` enforces the durable-log rules that matter here, taken from
 * `@deepseek-ai/dsh-session-format-v3-to-v4`:
 *
 *   - `turn/start` must open exactly the next turn number;
 *   - `step/start` must open exactly the next step of the open turn;
 *   - `turn/end` requires the open turn with no open step;
 *   - `system/message`, `developer/message`, `assistant/attempt`,
 *     `assistant/message`, `tool/call` and `tool/result` must sit in an open
 *     turn/step;
 *   - a `tool/call` must follow the assistant message that advertised it;
 *   - the first system message on the surface is protected from replacement.
 *
 * A log that violates any of these is exactly a log dsh refuses to reload, so
 * the runtime tests fail here before they could ever fail on a real host.
 */
import { randomUUID } from 'node:crypto';

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const STEP_TYPES = new Set(['system/message', 'developer/message', 'assistant/attempt', 'assistant/message', 'tool/call', 'tool/result']);

class SessionFormatError extends Error {}

function assert(condition, message) {
  if (!condition) throw new SessionFormatError(message);
}

/** Rebuild the surface of a log prefix, exactly as dsh does while decoding. */
export function foldSurface(log) {
  const nodes = [];
  let protectedHead;
  const tools = new Map();
  let turn = null;
  let step = null;
  let nextTurn = 1;
  let nextStep = 1;
  for (const event of log) {
    assert(typeof event.type === 'string' && event.data && typeof event.data === 'object', `invalid event at seq ${event.seq}`);
    if (SURFACE_TYPES.has(event.type)) {
      const op = event.surfaceOp;
      assert(op !== undefined, `${event.type} requires a surfaceOp`);
      if (op === 'append') {
        if (event.type === 'system/message' && nodes.length === 0) protectedHead = event.seq;
        nodes.push(event.seq);
      } else {
        const first = nodes.indexOf(op.startSeq);
        const last = nodes.indexOf(op.endSeq);
        assert(first >= 0 && last >= first, `${event.type} replacement range is not on the current surface`);
        const removed = nodes.slice(first, last + 1);
        const sources = event.sourceEventSeqs ?? [];
        for (const seq of removed) assert(sources.includes(seq), 'replacement sourceEventSeqs omit a shadowed surface node');
        if (protectedHead !== undefined && removed.includes(protectedHead)) {
          assert(event.type === 'system/message' && removed.length === 1, 'surface replacement cannot shadow the protected system head');
          protectedHead = event.seq;
        }
        nodes.splice(first, removed.length, event.seq);
      }
    } else {
      assert(event.surfaceOp === undefined, `${event.type} is not surface-eligible and cannot carry surfaceOp`);
    }
    if (STEP_TYPES.has(event.type)) {
      assert(turn !== null && step !== null && event.data.turn === turn && event.data.step === step, `${event.type} does not match an open turn and step`);
    }
    switch (event.type) {
      case 'turn/start':
        assert(turn === null && event.data.turn === nextTurn, 'turn/start does not open the expected turn');
        turn = nextTurn;
        nextStep = 1;
        tools.clear();
        break;
      case 'turn/end':
        assert(turn !== null && event.data.turn === turn && step === null, 'turn/end does not match the open turn with no open step');
        turn = null;
        nextTurn += 1;
        break;
      case 'step/start':
        assert(turn !== null && event.data.turn === turn && step === null && event.data.step === nextStep, 'step/start does not match the open turn and next step');
        step = nextStep;
        break;
      case 'step/end':
        assert(step !== null && event.data.turn === turn && event.data.step === step, 'step/end does not match the open step');
        step = null;
        nextStep += 1;
        break;
      case 'assistant/message': {
        for (const block of event.data.message?.content ?? []) {
          if (block?.type !== 'tool-call') continue;
          assert(!tools.has(block.id), `assistant/message repeats advertised tool call ${block.id}`);
          tools.set(block.id, { name: block.name, arguments: block.arguments, started: false });
        }
        break;
      }
      case 'tool/call': {
        const pending = tools.get(event.data.callId);
        assert(pending !== undefined, `tool/call ${event.data.callId} has no advertised tool lifecycle`);
        assert(!pending.started && pending.name === event.data.name && pending.arguments === event.data.arguments, `tool/call ${event.data.callId} does not match one advertised tool call`);
        pending.started = true;
        break;
      }
      case 'tool/result': {
        const id = event.data.message?.toolCallId;
        const pending = tools.get(id);
        assert(pending !== undefined && pending.started, `tool/result ${id} is not the exact TOOL_NOT_STARTED repair`);
        tools.delete(id);
        break;
      }
      default:
        break;
    }
  }
  return nodes;
}

export class FakeSession {
  constructor({ log = [], failAppend = false } = {}) {
    this.log = structuredClone(log);
    this.nodes = log.length > 0 ? foldSurface(this.log) : [];
    this.failAppend = failAppend;
    this.listeners = [];
    this.appends = 0;
    this.inheritedEventCount = 0;
  }

  get id() {
    return 'session-1';
  }

  get header() {
    return { version: 4, id: this.id, cwd: 'D:/work', isSeeded: false };
  }

  get seq() {
    return this.log.length;
  }

  get surface() {
    return {
      nodes: this.nodes,
      deriveEventMessage: (event) => (event.type === 'user/message' ? event.data : event.data?.message),
    };
  }

  snapshotEvents() {
    return structuredClone(this.log);
  }

  eventAt(seq) {
    return this.log[seq];
  }

  append(type, data, options = {}) {
    if (this.failAppend) throw new Error('append rejected');
    const seq = this.log.length;
    const event = { seq, time: seq + 1, type, data: structuredClone(data) };
    if (options.surfaceOp !== undefined) event.surfaceOp = options.surfaceOp;
    if (options.sourceEventSeqs !== undefined) event.sourceEventSeqs = [...options.sourceEventSeqs];
    const candidate = [...this.log, event];
    // Validate the whole candidate log: a bad append has to fail loudly here,
    // exactly like the durable decoder would on reload.
    const nodes = foldSurface(candidate);
    this.log = candidate;
    this.nodes = nodes;
    this.appends += 1;
    const { surfaceOp: _surfaceOp, sourceEventSeqs: _sources, ...plain } = event;
    for (const listener of this.listeners) listener(this, plain);
    return structuredClone(plain);
  }
}

/** Detached prefix session, mirroring `Session.fromRestore(session, events)`. */
export function detached(session, events) {
  return new FakeSession({ log: events });
}

export class FakeInbox {
  nextTurn = [];
  nextStep = [];
  prepend(target, message) {
    this[target === 'next-turn' ? 'nextTurn' : 'nextStep'].unshift(message);
  }
  claim() {
    const claimed = [...this.nextStep.splice(0, this.nextStep.length)];
    claimed.push(...this.nextTurn.splice(0, 1));
    return claimed;
  }
  get hasPending() {
    return this.nextTurn.length > 0 || this.nextStep.length > 0;
  }
}

/**
 * The slice of `ReactLoopAgent` the runtime uses.
 *
 * `runMaintenance` opens a model-free turn exactly like the host: the job runs
 * while the phase is `maintenance`, the steer marker wakes the driver, and the
 * driver opens one turn whose `pre-step` may reject it. `turn/end` is appended
 * by the driver, never by the plugin.
 */
export class FakeAgent {
  constructor(session, { preStep, maxTurns = 8 } = {}) {
    this.session = session;
    this.inbox = new FakeInbox();
    this.lastTurn = 0;
    this.phase = 'idle';
    this.preStep = preStep;
    this.maxTurns = maxTurns;
    this.state = 'idle';
    this.wake = false;
  }

  get status() {
    return this.phase === 'idle' ? 'idle' : 'running';
  }

  steer(message) {
    this.inbox.nextStep.push(message);
    this.wake = true;
  }

  async runMaintenance(job) {
    if (this.phase !== 'idle') throw new Error(`agent "${this.session.id}" already has active work`);
    this.phase = 'maintenance';
    try {
      await job();
    } finally {
      this.phase = 'idle';
    }
    if (!this.wake) return undefined;
    this.wake = false;
    for (let index = 0; index < this.maxTurns; index += 1) {
      const more = await this.#turn();
      if (!more) break;
    }
    return undefined;
  }

  async #turn() {    const turn = this.lastTurn + 1;
    const session = this.session;
    session.append('turn/start', { turn });
    this.lastTurn = turn;
    let rejected = false;
    let messages = this.inbox.claim();
    let step = 1;
    while (true) {
      const decision = await this.preStep?.({ agent: this, messages, turn, step, signal: new AbortController().signal }, () => ({
        kind: 'enter',
        messages,
      }));
      if (decision?.kind === 'reject') {
        rejected = true;
        break;
      }
      session.append('step/start', { turn, step });
      for (const message of decision?.messages ?? messages) {
        session.append('user/message', message, { surfaceOp: 'append' });
      }
      session.append(
        'assistant/message',
        { turn, step, message: assistant(`a-${turn}-${step}`), stream: [] },
        { surfaceOp: 'append' },
      );
      session.append('step/end', { turn, step });
      step += 1;
      if (!this.inbox.hasPending) break;
      messages = this.inbox.claim();
    }
    session.append('turn/end', { turn, reason: rejected ? { kind: 'blocked' } : { kind: 'completed' } });
    return this.inbox.hasPending;
  }

  /** One ordinary turn, letting the caller mutate files around the step. */
  async turnWith(text, { before, after } = {}) {
    const session = this.session;
    const turn = this.lastTurn + 1;
    session.append('turn/start', { turn });
    this.lastTurn = turn;
    const messages = [user(`m${turn}`, text)];
    const decision = await this.preStep?.({ agent: this, messages, turn, step: 1 }, () => ({ kind: 'enter', messages }));
    if (decision?.kind !== 'enter') throw new Error('a plain step must not be rejected');
    await before?.();
    session.append('step/start', { turn, step: 1 });
    let userSeq;
    for (const message of decision.messages) {
      const row = session.append('user/message', message, { surfaceOp: 'append' });
      userSeq ??= row.seq;
    }
    await after?.();
    session.append(
      'assistant/message',
      { turn, step: 1, message: assistant(`a${turn}`, `answer ${turn}`), stream: [], usage: { input: 1, output: 1 } },
      { surfaceOp: 'append' },
    );
    session.append('step/end', { turn, step: 1 });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
    return { turn, userSeq };
  }
}

export const user = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: text === undefined ? [] : [{ type: 'text', text }],
});

export const assistant = (id, text) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'test', model: 'test' },
  content: text === undefined ? [] : [{ type: 'text', text }],
});

export const marker = () => ({
  id: `dsh-tui-undo:maintenance:${randomUUID()}`,
  role: 'user',
  source: { kind: 'dsh-tui-undo' },
  content: [{ type: 'text', text: 'rewind' }],
});

/** File store with content-addressed trees, like the shadow git repository. */
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
}

/**
 * Seed `count` human turns, each with an assistant row and a recorded file
 * snapshot, and return the sequences tests need.
 */
export async function seedTurns(session, snapshot, count = 3) {
  const turns = [];
  let head = (await snapshot.capture()).tree;
  for (let index = 1; index <= count; index += 1) {
    session.append('turn/start', { turn: index });
    session.append('step/start', { turn: index, step: 1 });
    const userSeq = session.append('user/message', user(`m${index}`, `message ${index}`), { surfaceOp: 'append' }).seq;
    snapshot.current.set('a.txt', `a${index + 1}`);
    if (index === 2) snapshot.current.set('b.txt', 'b1');
    const end = (await snapshot.capture()).tree;
    const assistantSeq = session.append(
      'assistant/message',
      { turn: index, step: 1, message: assistant(`a${index}`, `answer ${index}`), stream: [], usage: { input: 1, output: 1 } },
      { surfaceOp: 'append' },
    ).seq;
    session.append('step/end', { turn: index, step: 1 });
    session.append('turn/end', { turn: index, reason: { kind: 'completed' } });
    const files = await snapshot.files(head, end);
    turns.push({ turn: index, userSeq, assistantSeq, snapshot: { start: head, end, files } });
    head = end;
  }
  return turns;
}
