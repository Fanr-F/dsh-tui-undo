import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SnapshotService } from './snapshot.mjs';
import { gitAvailable } from './git.mjs';
import { StateError, operationId, readState, writeState } from './store.mjs';
import { beforeSeq, mergeRanges, userTargets } from './history.mjs';
import { buildReplay } from './replay.mjs';
import { plan as filePlan } from './timeline.mjs';
import { workspaceDirectory } from './paths.mjs';

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
  #scope;
  #snapshots = new Map();
  #git = new Map();
  #pending = new Map();
  #queue = new Map();
  #writes = new Map();
  #tasks = new Set();
  #ops = new Map();
  #recovered = new Set();

  constructor({ root, host, cwdOf, flush, logger, scope = '.', probeGit = gitAvailable, openSnapshot } = {}) {
    if (!root || !host || !cwdOf) throw new TypeError('RewindRuntime needs root, host and cwdOf');
    this.#root = root;
    this.#host = host;
    this.#cwdOf = cwdOf;
    this.#flush = flush ?? (async () => {});
    this.#probeGit = probeGit;
    this.#openSnapshot = openSnapshot ?? ((options) => SnapshotService.open(options));
    this.#logger = logger ?? { warn() {}, info() {} };
    this.#scope = scope;
  }

  get available() {
    return this.#host.available !== false;
  }

  /** `agent/pre-step`: capture for a live step, or rewrite from a maintenance turn. */
  async preStep({ agent, messages = [], turn } = {}, next) {
    const session = agent?.session;
    if (!session?.id) return next();
    const operation = this.#ops.get(session.id);
    if (operation) return this.#intercept(agent, operation, { messages, turn });
    try {
      await this.#ensureRecovered(session);
      await this.checkpoint(session, messages);
      await this.capture(session);
    } catch (error) {
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

  async status(session) {
    const state = await readState(this.#root, session.id);
    const context = await this.#context(session, { optional: true });
    return {
      undoAvailable: state.undo.length > 0,
      redoAvailable: state.redo.length > 0,
      view: state.view,
      filesAvailable: Boolean(context?.hasGit),
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
    const entry = {
      id: operationId(),
      targetSeq: seq,
      beforeSeq: session.seq,
      files: useFiles ? [...filePlan({ timeline: session.snapshotEvents(), snapshots: state.snapshots, boundarySeq: seq, copies: state.copies }).keys()] : [],
      head,
      createdAt: Date.now(),
    };
    return this.#launch(agent, { op: 'undo', entry, useFiles, text: target.text });
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
    if (!context?.hasGit) return;
    const tree = await this.#captureTree(context);
    this.#pending.set(session.id, { start: tree });
  }

  dispose() {
    for (const operation of this.#ops.values()) operation.reject(new StateError('撤回插件已卸载'));
    this.#ops.clear();
  }

  // ---------------------------------------------------------------- internals

  async #intercept(agent, operation, { messages, turn }) {
    if (operation.turn !== undefined) return { kind: 'reject' };
    operation.turn = turn;
    // The marker rides in `next-step`; claiming a step also steals one queued
    // turn. Hand everything that is not our marker back to the inbox.
    for (const message of [...messages].reverse()) {
      if (message?.id === operation.marker) continue;
      agent.inbox.prepend(operation.queue.get(message?.id) ?? 'next-turn', message);
    }
    try {
      operation.result = await this.#apply(agent, operation, turn);
    } catch (error) {
      operation.error = error;
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
    const start = session.seq;
    const { events, copies } = buildReplay(session, desired, {
      turn,
      step: 1,
      createDetached: this.#host.createDetached,
      validate: this.#host.validate,
    });
    if (!events.length) throw new StateError('没有可重放的内容');

    const restore = operation.useFiles && context?.hasGit ? this.#restorePlan(operation, state, session, cut) : new Map();
    const picture = { ...(state.copies ?? {}) };
    for (const entry of copies) picture[entry.seq] = entry.origin;
    // The marker row and the host's `turn/end` both land after our events.
    const endSeq = start + events.length + 1;
    const internal = { start, end: endSeq + 1 };
    const hiddenRange = { start: cut, end: Math.max(cut, start - 1) };
    let next;
    if (operation.op === 'undo') {
      next = {
        ...state,
        undo: [...state.undo, { ...operation.entry, endSeq }],
        redo: [],
        copies: picture,
        view: { cut },
        hiddenRanges: mergeRanges([...state.hiddenRanges, hiddenRange]),
        internalRanges: mergeRanges([...state.internalRanges, internal]),
      };
    } else {
      next = {
        ...state,
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, operation.entry],
        copies: picture,
        view: { cut: null },
        hiddenRanges: mergeRanges([...state.hiddenRanges, hiddenRange]),
        internalRanges: mergeRanges([...state.internalRanges, internal]),
      };
    }

    const journal = {
      id: operation.entry.id,
      op: operation.op,
      turn,
      startSeq: start,
      state: { ...next, journal: null },
      rollback: { head: operation.entry.head ?? null, files: [...restore.keys()] },
    };
    await this.#mutate(session.id, async (current) => {
      if (current.journal) throw new StateError('上一次撤回还没有完成，请稍后再试');
      return writeState(this.#root, { ...current, journal });
    });

    let restored;
    try {
      if (restore.size) restored = await context.snapshot.restore(restore);
      for (const event of events) {
        if (session.seq !== event.seq) throw new StateError('会话在撤回过程中发生了变化，请重新试一次');
        const options = {};
        if (event.surfaceOp !== undefined) options.surfaceOp = event.surfaceOp;
        if (event.sourceEventSeqs) options.sourceEventSeqs = event.sourceEventSeqs;
        session.append(event.type, event.data, options);
      }
      this.#host.appendPluginRecord?.(session, 'plugin:dsh-tui-undo/commit', { id: operation.entry.id });
      await this.#flush(session);
    } catch (error) {
      await this.#rollback(session, context, journal).catch((failure) => {
        this.#logger?.warn?.(`dsh-tui-undo: 回滚文件失败：${failure?.message ?? failure}`);
      });
      throw error;
    }

    return { files: restore.size, restored, view: next.view, endSeq };
  }

  async #finish(session, operation, event) {
    try {
      await this.#flush(session);
      let state;
      await this.#mutate(session.id, async (current) => {
        const planned = current.journal?.state;
        if (!planned) {
          state = current;
          return current;
        }
        state = await writeState(this.#root, { ...planned, journal: null });
        return state;
      });
      if (operation.error) operation.reject(operation.error);
      else operation.resolve({ ...operation.result, state });
    } catch (error) {
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
      });
    } catch (error) {
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
