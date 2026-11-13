import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SnapshotService } from './snapshot.mjs';
import { gitAvailable } from './git.mjs';
import { StateError, operationId, readState, writeState } from './store.mjs';
import { beforeSeq, mergeRanges, userTargets } from './history.mjs';
import { buildReplay } from './replay.mjs';
import { plan as filePlan } from './timeline.mjs';
import { workspaceDirectory } from './paths.mjs';
import { describeError } from './log.mjs';

/**
 * Undo / redo orchestration for one plugin instance.
 *
 * A rewind is a *maintenance turn*: the plugin asks the agent for a real,
 * model-free turn (`agent.runMaintenance`), steers a marker message so the loop
 * opens `turn/start`, and then rewrites the conversation from `agent/pre-step`
 * before returning `{ kind: 'reject' }`. The loop appends `turn/end` itself, so
 * every replayed message lives in a legal turn/step and the session still
 * reloads. Nothing is truncated, nothing is forked, no turn number is invented.
 *
 * Order inside the borrowed step:
 *   build+validate replay → journal → restore files → append → flush → commit
 * state at `turn/end`. A crash anywhere keeps the journal, and the next step
 * either adopts the committed log (commit marker present) or rolls the files
 * back.
 */
export class RewindRuntime {
  #root;
  #host;
  #cwdOf;
  #flush;
  #probeGit;
  #openSnapshot;
  #logger;
  #log;
  #scope;
  #snapshots = new Map();
  #git = new Map();
  #pending = new Map();
  #queue = new Map();
  #writes = new Map();
  #tasks = new Set();
  #ops = new Map();
  #recovered = new Set();

  constructor({ root, host, cwdOf, flush, logger, scope = '.', probeGit = gitAvailable, openSnapshot, log } = {}) {
    if (!root || !host || !cwdOf) throw new TypeError('RewindRuntime needs root, host and cwdOf');
    this.#root = root;
    this.#host = host;
    this.#cwdOf = cwdOf;
    this.#flush = flush ?? (async () => {});
    this.#probeGit = probeGit;
    this.#openSnapshot = openSnapshot ?? ((options) => SnapshotService.open(options));
    this.#logger = logger ?? { warn() {}, info() {} };
    this.#scope = scope;
    this.#log = log ?? { file: null, write() {}, async flush() {}, async tail() { return ''; } };
  }

  #trace(scope, message, data) {
    void this.#log.write(scope, message, data);
  }

  get available() {
    return this.#host.available !== false;
  }

  /** Where the diagnostic log lives, for `/undo-status` and error hints. */
  get logFile() {
    return this.#log.file ?? null;
  }

  /** `agent/pre-step`: capture for a live step, or rewrite from a maintenance turn. */
  async preStep({ agent, messages = [], turn } = {}, next) {
    const session = agent?.session;
    if (!session?.id) return next();
    const operation = this.#ops.get(session.id);
    if (operation) {
      this.#trace('prestep', 'claim maintenance turn', { session: session.id, turn, seq: session.seq, messages: messages.length });
      return this.#intercept(agent, operation, { messages, turn });
    }
    try {
      await this.#ensureRecovered(session);
      await this.checkpoint(session, messages);
      await this.capture(session);
    } catch (error) {
      this.#trace('prestep', 'capture failed', describeError(error));
      this.#logger?.warn?.(`dsh-tui-undo: 步骤快照失败：${error?.message ?? error}`);
    }
    return next();
  }

  /** `session/event`: finish a step snapshot, or close a maintenance operation. */
  event(session, event) {
    if (event?.type === 'turn/end') {
      const operation = this.#ops.get(session.id);
      if (operation && operation.turn === event.data?.turn) {
        this.#pending.delete(session.id);
        return this.#track(
          this.#finish(session, operation, event).catch((error) => {
            this.#ops.delete(session.id);
            operation.reject(error);
          }),
        );
      }
      this.#pending.delete(session.id);
      return undefined;
    }
    if (event?.type !== 'assistant/message') return undefined;
    const pending = this.#pending.get(session.id);
    if (!pending) return undefined;
    this.#pending.delete(session.id);
    return this.#track(
      this.#recordStep(session, event.seq, pending.start).catch((error) => {
        this.#logger?.warn?.(`dsh-tui-undo: 步骤快照失败：${error?.message ?? error}`);
      }),
    );
  }

  #track(task) {
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
    return task;
  }

  /** Wait for every pending state write (tests and shutdown). */
  async settle() {
    while (this.#tasks.size > 0 || this.#writes.size > 0) {
      await Promise.all([...this.#tasks, ...this.#writes.values()]);
    }
  }

  /** Human turns the user can rewind to, oldest first. */
  targets(session) {
    return userTargets(session).map((target) => ({
      ...target,
      label: short(target.text, 100) || '（附件消息）',
    }));
  }

  /**
   * What a UI needs to hide rewind rows, addressable by session id alone.
   *
   * The web client asks for this after every commit marker, so it must not
   * resume an agent or require an open session.
   */
  async stateFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new StateError('缺少会话 id');
    const state = await readState(this.#root, sessionId);
    return {
      revision: state.revision,
      hiddenRanges: state.hiddenRanges,
      internalRanges: state.internalRanges,
      undoAvailable: state.undo.length > 0,
      redoAvailable: state.redo.length > 0,
      view: state.view,
      busy: Boolean(state.journal),
    };
  }

  async status(session) {
    const state = await readState(this.#root, session.id);
    const context = await this.#context(session, { optional: true });
    return {
      undoAvailable: state.undo.length > 0,
      redoAvailable: state.redo.length > 0,
      view: state.view,
      filesAvailable: Boolean(context?.hasGit),
      cwd: context?.cwd ?? null,
      snapshots: Object.keys(state.snapshots).length,
      snapshottedSeqs: Object.keys(state.snapshots).map(Number).sort((left, right) => left - right),
      undoDepth: state.undo.length,
      redoDepth: state.redo.length,
      busy: Boolean(state.journal),
      lastTarget: state.undo.at(-1)?.targetSeq ?? null,
    };
  }

  /** Rewind to just before the user message at `seq`. */
  async undo({ agent, seq, files = true }) {
    const session = agent?.session;
    if (!session?.id) throw new StateError('当前没有可操作的会话');
    if (!this.available) throw new StateError(this.#host.reason ?? '撤回功能不可用');
    this.#assertIdle(session);
    const target = userTargets(session).find((item) => item.seq === seq);
    if (!target) throw new StateError('这条消息已经不在当前对话中');
    const state = await readState(this.#root, session.id);
    if (state.journal) throw new StateError('上一次撤回还没有完成，请稍后再试');
    const context = await this.#context(session, { optional: true });
    const useFiles = Boolean(files && context?.hasGit);
    let head;
    if (useFiles) head = await this.#captureTree(context);
    const planned = useFiles
      ? filePlan({ timeline: session.snapshotEvents(), snapshots: state.snapshots, boundarySeq: seq, copies: state.copies })
      : new Map();
    const entry = {
      id: operationId(),
      targetSeq: seq,
      beforeSeq: session.seq,
      files: [...planned.keys()],
      head,
      createdAt: Date.now(),
    };
    this.#trace('undo', 'requested', {
      session: session.id,
      targetSeq: seq,
      beforeSeq: entry.beforeSeq,
      hasGit: Boolean(context?.hasGit),
      cwd: context?.cwd ?? null,
      snapshots: Object.keys(state.snapshots).length,
      planned: [...planned.keys()],
      head: head?.slice(0, 10) ?? null,
    });
    const result = await this.#launch(agent, { op: 'undo', entry, useFiles, text: target.text });
    this.#trace('undo', 'completed', { seq, files: result?.files ?? 0, snapshots: Object.keys(state.snapshots).length });
    return {
      ...result,
      filesAvailable: useFiles,
      snapshots: Object.keys(state.snapshots).length,
      plannedPaths: [...planned.keys()],
    };
  }

  /** Re-apply the rewind that the last undo replaced. */
  async redo({ agent, files = true }) {
    const session = agent?.session;
    if (!session?.id) throw new StateError('当前没有可操作的会话');
    if (!this.available) throw new StateError(this.#host.reason ?? '撤回功能不可用');
    this.#assertIdle(session);
    const state = await readState(this.#root, session.id);
    if (state.journal) throw new StateError('上一次撤回还没有完成，请稍后再试');
    const entry = state.undo.at(-1);
    if (!entry) throw new StateError('没有可重做的撤回');
    const newer = session
      .snapshotEvents()
      .some((event) => event.seq > (entry.endSeq ?? 0) && event.type === 'user/message' && event.data?.source?.kind === 'user');
    if (newer) throw new StateError('撤回之后又有了新消息，无法重做');
    const context = await this.#context(session, { optional: true });
    return this.#launch(agent, { op: 'redo', entry, useFiles: Boolean(files && context?.hasGit), text: '' });
  }

  /** A new human message invalidates the redo side of the stack. */
  async checkpoint(session, messages) {
    const fresh = (messages ?? []).some((message) => message?.source?.kind === 'user');
    if (!fresh) return;
    const state = await readState(this.#root, session.id);
    if (!state.redo.length && state.view?.cut === null) return;
    await this.#mutate(session.id, async (current) => {
      if (!current.redo.length && current.view?.cut === null) return current;
      return writeState(this.#root, { ...current, redo: [], view: { cut: null } });
    });
  }

  async capture(session) {
    const context = await this.#context(session, { optional: true });
    if (!context?.hasGit) {
      this.#trace('capture', 'skipped (no git)', { cwd: context?.cwd ?? null });
      return;
    }
    const tree = await this.#captureTree(context);
    this.#pending.set(session.id, { start: tree });
    this.#trace('capture', 'captured step start', { cwd: context.cwd, tree: tree?.slice(0, 10) });
  }

  dispose() {
    for (const operation of this.#ops.values()) operation.reject(new StateError('撤回插件已卸载'));
    this.#ops.clear();
  }

  // ---------------------------------------------------------------- internals

  async #intercept(agent, operation, { messages, turn }) {
    if (operation.turn !== undefined) {
      this.#trace('prestep', 'already claimed', { turn });
      return { kind: 'reject' };
    }
    operation.turn = turn;
    // The marker rides in `next-step`; claiming a step also steals one queued
    // turn. Hand everything that is not our marker back to the inbox.
    let returned = 0;
    for (const message of [...messages].reverse()) {
      if (message?.id === operation.marker) continue;
      agent.inbox.prepend(operation.queue.get(message?.id) ?? 'next-turn', message);
      returned += 1;
    }
    this.#trace('apply', 'start', { op: operation.op, turn, seq: agent.session.seq, returned });
    try {
      operation.result = await this.#apply(agent, operation, turn);
    } catch (error) {
      operation.error = error;
      this.#trace('apply', 'failed', describeError(error));
    }
    return { kind: 'reject' };
  }

  async #apply(agent, operation, turn) {
    const session = agent.session;
    const context = await this.#context(session, { optional: true });
    const state = await readState(this.#root, session.id);
    if (state.journal) throw new StateError('上一次撤回还没有完成，请稍后再试');

    const cut = operation.op === 'undo' ? operation.entry.targetSeq : operation.entry.beforeSeq;
    const desired = beforeSeq(session, cut, { createDetached: this.#host.createDetached });
    this.#trace('apply', 'planned', {
      op: operation.op,
      cut,
      liveSeq: session.seq,
      desired: desired.length,
      cwd: context?.cwd ?? null,
      hasGit: Boolean(context?.hasGit),
    });
    // Dry run: prove the replay decodes *before* the journal and the files move.
    // The real build happens again right before the append, so a host that
    // records its own bookkeeping events during the awaits below cannot shift
    // our sequence numbers; only the ranges are settled at `turn/end`.
    const preview = buildReplay(session, desired, {
      turn,
      step: 1,
      createDetached: this.#host.createDetached,
      validate: this.#host.validate,
    });
    if (!preview.events.length) throw new StateError('没有可重放的内容');
    this.#trace('apply', 'preview built', {
      events: preview.events.length,
      firstSeq: preview.events[0]?.seq,
      marker: preview.marker,
      copies: preview.copies.length,
    });

    const restore = operation.useFiles && context?.hasGit ? this.#restorePlan(operation, state, session, cut) : new Map();
    let next;
    if (operation.op === 'undo') {
      next = {
        ...state,
        undo: [...state.undo, { ...operation.entry }],
        redo: [],
        view: { cut },
      };
    } else {
      next = {
        ...state,
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, operation.entry],
        view: { cut: null },
      };
    }

    const journal = {
      id: operation.entry.id,
      op: operation.op,
      turn,
      startSeq: session.seq,
      state: { ...next, journal: null },
      rollback: { head: operation.entry.head ?? null, files: [...restore.keys()] },
    };
    await this.#mutate(session.id, async (current) => {
      if (current.journal) throw new StateError('上一次撤回还没有完成，请稍后再试');
      this.#trace('apply', 'journal written', { id: journal.id, files: journal.rollback.files });
      return writeState(this.#root, { ...current, journal });
    });

    let restored;
    let start;
    let events;
    let copies;
    let marker;
    try {
      if (restore.size) {
        this.#trace('apply', 'restoring files', { files: [...restore.keys()] });
        restored = await context.snapshot.restore(restore);
        this.#trace('apply', 'restored', { restored: restored?.restored?.length ?? 0, removed: restored?.removed?.length ?? 0, failed: restored?.failed?.length ?? 0 });
      }
      // Rebuild against the live session, then append synchronously: from here
      // to the last `append` there is no await, so the numbering cannot drift.
      start = session.seq;
      ({ events, copies, marker } = buildReplay(session, desired, {
        turn,
        step: 1,
        createDetached: this.#host.createDetached,
        validate: this.#host.validate,
      }));
      this.#trace('apply', 'appending', {
        start,
        events: events.length,
        firstSeq: events[0]?.seq,
        lastSeq: events.at(-1)?.seq,
        marker,
      });
      for (const event of events) {
        const options = {};
        if (event.surfaceOp !== undefined) options.surfaceOp = event.surfaceOp;
        if (event.sourceEventSeqs) options.sourceEventSeqs = event.sourceEventSeqs;
        session.append(event.type, event.data, options);
      }
      // The commit marker is a recovery aid, never a requirement: a host that
      // refuses plugin records must not fail the rewind itself.
      try {
        this.#host.appendPluginRecord?.(session, 'plugin:dsh-tui-undo/commit', { id: operation.entry.id });
      } catch (markerError) {
        this.#logger?.warn?.(`dsh-tui-undo: 提交标记写入失败：${markerError?.message ?? markerError}`);
      }
      await this.#flush(session);
      this.#trace('apply', 'flushed', { seq: session.seq });
    } catch (error) {
      this.#trace('apply', 'append failed', describeError(error));
      await this.#rollback(session, context, journal).catch((failure) => {
        this.#logger?.warn?.(`dsh-tui-undo: 回滚文件失败：${failure?.message ?? failure}`);
        this.#trace('apply', 'rollback failed', describeError(failure));
      });
      throw error;
    }

    // `turn/end` returns the real end sequence; ranges are settled there.
    operation.settlement = { cut, start, marker, copies, journalStart: journal.startSeq };
    return { files: restore.size, paths: [...restore.keys()], restored, view: next.view };
  }

  /**
   * Fold the operation's real sequence numbers into the planned state.
   *
   * `turn/end` is the first moment the final sequence is known: the host may
   * append its own records between our build and our append, so ranges and
   * `endSeq` are settled here rather than predicted.
   */
  #settle(planned, operation, endSeq) {
    const settlement = operation.settlement;
    if (!settlement) return { ...planned, journal: null };
    const copies = { ...(planned.copies ?? {}) };
    for (const entry of settlement.copies ?? []) copies[entry.seq] = entry.origin;
    const hiddenRanges = mergeRanges([
      ...(planned.hiddenRanges ?? []),
      { start: settlement.cut, end: Math.max(settlement.cut, settlement.start - 1) },
      ...(Number.isSafeInteger(settlement.marker) ? [{ start: settlement.marker, end: settlement.marker }] : []),
    ]);
    const turnStart = Number.isSafeInteger(operation.start) ? operation.start : settlement.journalStart;
    const next = {
      ...planned,
      journal: null,
      copies,
      hiddenRanges,
      internalRanges: mergeRanges([...(planned.internalRanges ?? []), { start: turnStart, end: endSeq }]),
    };
    if (operation.op === 'undo' && next.undo.length > 0) {
      next.undo = [...next.undo.slice(0, -1), { ...next.undo.at(-1), endSeq }];
    }
    if (operation.op === 'redo' && next.redo.length > 0) {
      next.redo = [...next.redo.slice(0, -1), { ...next.redo.at(-1), endSeq }];
    }
    return next;
  }

  async #finish(session, operation, event) {
    try {
      await this.#flush(session);
      let state;
      await this.#mutate(session.id, async (current) => {
        const planned = current.journal?.state;
        if (!planned) {
          this.#trace('finish', 'no journal to settle', { turn: event.data?.turn, endSeq: event.seq });
          state = current;
          return current;
        }
        state = await writeState(this.#root, this.#settle(planned, operation, event.seq));
        this.#trace('finish', 'settled', {
          turn: event.data?.turn,
          endSeq: event.seq,
          undo: state.undo.length,
          redo: state.redo.length,
          hidden: state.hiddenRanges.length,
        });
        return state;
      });
      if (operation.error) {
        this.#trace('finish', 'operation failed', describeError(operation.error));
        operation.reject(operation.error);
      } else {
        operation.resolve({ ...operation.result, state });
      }
    } catch (error) {
      this.#trace('finish', 'settle failed', describeError(error));
      operation.reject(error);
    } finally {
      this.#ops.delete(session.id);
    }
  }

  async #launch(agent, operation) {
    const session = agent.session;
    if (typeof agent.runMaintenance !== 'function') throw new StateError('当前会话不支持撤回所需的维护回合');
    if (this.#ops.has(session.id)) throw new StateError('撤回正在进行中');
    const done = Promise.withResolvers();
    const record = {
      ...operation,
      done,
      resolve: done.resolve,
      reject: done.reject,
      marker: undefined,
      turn: undefined,
      start: session.seq,
      queue: new Map(),
      result: undefined,
      error: undefined,
    };
    this.#ops.set(session.id, record);
    try {
      await agent.runMaintenance(async () => {
        const marker = {
          id: `dsh-tui-undo:maintenance:${randomUUID()}`,
          role: 'user',
          source: { kind: 'dsh-tui-undo' },
          content: [{ type: 'text', text: 'rewind' }],
        };
        record.marker = marker.id;
        record.start = session.seq;
        record.queue = new Map([
          ...[...agent.inbox.nextTurn].map((message) => [message.id, 'next-turn']),
          ...[...agent.inbox.nextStep].map((message) => [message.id, 'next-step']),
        ]);
        agent.steer(marker);
        this.#trace('launch', 'maintenance requested', {
          op: record.op,
          session: session.id,
          seq: session.seq,
          marker: record.marker,
          queued: record.queue.size,
        });
      });
    } catch (error) {
      this.#trace('launch', 'runMaintenance failed', describeError(error));
      this.#ops.delete(session.id);
      throw error;
    }
    return done.promise;
  }

  #restorePlan(operation, state, session, cut) {
    if (operation.op === 'redo') {
      const files = new Map();
      if (operation.entry.head) for (const file of operation.entry.files ?? []) files.set(file, operation.entry.head);
      return files;
    }
    return filePlan({ timeline: session.snapshotEvents(), snapshots: state.snapshots, boundarySeq: cut, copies: state.copies });
  }

  async #rollback(session, context, journal) {
    const head = journal.rollback?.head;
    const files = journal.rollback?.files ?? [];
    if (head && files.length && context?.hasGit) {
      await context.snapshot.restore(new Map(files.map((file) => [file, head])));
    }
    await this.#mutate(session.id, async (current) => writeState(this.#root, { ...current, journal: null }));
  }

  async #recordStep(session, seq, start) {
    const context = await this.#context(session, { optional: true });
    if (!context?.hasGit) return;
    const end = await this.#captureTree(context);
    const snapshot = { start, end };
    if (start !== end) {
      snapshot.files = await context.snapshot.files(start, end);
    } else {
      snapshot.files = [];
    }
    this.#trace('capture', 'recorded step', { seq, start: start?.slice(0, 10), end: end?.slice(0, 10), files: snapshot.files });
    await this.#mutate(session.id, async (current) => {
      return writeState(this.#root, { ...current, snapshots: { ...current.snapshots, [seq]: snapshot } });
    });
  }

  async #ensureRecovered(session) {
    if (this.#recovered.has(session.id)) return;
    const state = await readState(this.#root, session.id);
    if (!state.journal) {
      this.#recovered.add(session.id);
      return;
    }
    const context = await this.#context(session, { optional: true });
    const committed = session
      .snapshotEvents()
      .some((event) => event.type === 'plugin:dsh-tui-undo/commit' && event.data?.id === state.journal.id);
    if (committed) {
      await this.#mutate(session.id, async (current) => writeState(this.#root, { ...(current.journal?.state ?? current), journal: null }));
      this.#logger?.warn?.('dsh-tui-undo: 已恢复上次中断的撤回（日志已提交）');
      this.#recovered.add(session.id);
      return;
    }
    await this.#rollback(session, context, state.journal);
    this.#logger?.warn?.('dsh-tui-undo: 已回滚上次中断的撤回（文件已还原）');
    this.#recovered.add(session.id);
  }

  #assertIdle(session) {
    if (this.#pending.has(session.id)) throw new StateError('会话正在执行，请先停止再撤回');
  }

  async #context(session, { optional = false } = {}) {
    if (!session?.id) throw new StateError('当前没有可操作的会话');
    const cwd = await this.#cwdOf(session);
    if (!cwd) {
      if (optional) return undefined;
      throw new StateError('会话没有本地工作目录');
    }
    const hasGit = await this.#hasGit(cwd);
    const snapshot = hasGit ? await this.#snapshotFor(cwd) : undefined;
    return { cwd, hasGit, snapshot, root: workspaceDirectory(this.#root, cwd) };
  }

  async #captureTree(context) {
    const captured = await this.#serialized(context.cwd, () => context.snapshot.capture({ scope: this.#scope }));
    return captured?.tree;
  }

  async #hasGit(cwd) {
    if (!this.#git.has(cwd)) this.#git.set(cwd, this.#probeGit(cwd).catch(() => false));
    return this.#git.get(cwd);
  }

  async #snapshotFor(cwd) {
    if (!this.#snapshots.has(cwd)) {
      const pending = Promise.resolve(
        this.#openSnapshot({
          worktree: cwd,
          root: workspaceDirectory(this.#root, cwd),
        }),
      ).catch((error) => {
        this.#snapshots.delete(cwd);
        throw error;
      });
      this.#snapshots.set(cwd, pending);
    }
    return this.#snapshots.get(cwd);
  }

  async #serialized(cwd, run) {
    const previous = this.#queue.get(cwd) ?? Promise.resolve();
    const next = previous.then(() => run(), () => run());
    const tail = next.catch(() => {});
    this.#queue.set(cwd, tail);
    try {
      return await next;
    } finally {
      if (this.#queue.get(cwd) === tail) this.#queue.delete(cwd);
    }
  }

  /** Serialize every state-file mutation for one session. */
  async #mutate(sessionId, run) {
    const previous = this.#writes.get(sessionId) ?? Promise.resolve();
    const step = async () => run(await readState(this.#root, sessionId));
    const next = previous.then(step, step);
    const tail = next.catch(() => {});
    this.#writes.set(sessionId, tail);
    try {
      return await next;
    } finally {
      if (this.#writes.get(sessionId) === tail) this.#writes.delete(sessionId);
    }
  }
}

export function defaultRewindRoot() {
  return process.env.DSH_REWIND_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'rewind');
}

function short(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}
