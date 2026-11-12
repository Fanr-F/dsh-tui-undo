import { join } from 'node:path';
import { SnapshotService } from './snapshot.mjs';
import { SnapshotRecorder } from './collect.mjs';
import { RevertService } from './revert.mjs';
import { StateError } from './store.mjs';
import { workspaceDirectory } from './paths.mjs';

/**
 * Host-agnostic orchestration: capture per step, record per message, undo/redo
 * per request.
 *
 * Everything the harness owns arrives through injected functions (`portFor`,
 * `cwdOf`, `openSnapshot`), so this class is exercised by tests without a
 * running DSH instance.
 */
export class RewindRuntime {
  #root;
  #portFor;
  #cwdOf;
  #openSnapshot;
  #logger;
  #scope;
  #snapshots = new Map();
  #pending = new Map();
  #queue = new Map();

  constructor({ root, portFor, cwdOf, openSnapshot, scope = '.', logger } = {}) {
    if (!root || !portFor || !cwdOf) throw new TypeError('RewindRuntime needs root, portFor and cwdOf');
    this.#root = root;
    this.#portFor = portFor;
    this.#cwdOf = cwdOf;
    this.#openSnapshot = openSnapshot ?? ((options) => SnapshotService.open(options));
    this.#logger = logger ?? { warn() {}, info() {} };
    this.#scope = scope;
  }

  /** Pre-capture the worktree for the step that is about to run. */
  async preStep({ session }) {
    const context = await this.#context(session);
    await this.#commitIfSuperseded(context);
    const captured = await this.#serialized(context.cwd, () => context.snapshot.capture({ scope: this.#scope }));
    this.#pending.set(session.id, { start: captured.tree, uncovered: captured.uncovered });
    return { tree: captured.tree, uncovered: captured.uncovered };
  }

  /** Record the assistant message that closed a step. */
  async event({ session, event: row }) {
    if (row?.type === 'turn/end') {
      // A turn that produced no assistant message leaves no snapshot to finish.
      this.#pending.delete(session.id);
      return undefined;
    }
    if (row?.type !== 'assistant/message') return undefined;
    const pending = this.#pending.get(session.id);
    // Redo copies are appended assistant messages too, but no step captured
    // them; recording one would snapshot the *current* worktree under the
    // copy's sequence number and race the redo's own state write.
    if (!pending) return undefined;
    const context = await this.#context(session);
    this.#pending.delete(session.id);
    const { snapshot } = await context.recorder.finish(row.seq, pending.start);
    return snapshot;
  }

  /** Forget a pre-capture that never produced an assistant message. */
  forget(session) {
    return this.#pending.delete(session.id);
  }

  async targets(session) {
    const context = await this.#context(session);
    const targets = await context.revert.targets();
    return targets.map((target) => {
      const event = context.port.events().find((row) => row.seq === target.seq);
      return { ...target, text: messageText(event) };
    });
  }

  async preview(session, target) {
    const context = await this.#context(session);
    return context.revert.preview(target);
  }

  async undo({ session, target, seq, messageID, files = true }) {
    this.#assertIdle(session);
    const context = await this.#context(session);
    return context.revert.undo({ target: target ?? seq, seq: seq ?? target, messageID, files });
  }

  async redo({ session, files = true }) {
    this.#assertIdle(session);
    const context = await this.#context(session);
    return context.revert.redo({ files });
  }

  async commit(session) {
    const context = await this.#context(session);
    return context.revert.commit();
  }

  async status(session) {
    const context = await this.#context(session);
    const state = await context.revert.state();
    return {
      cwd: context.cwd,
      revert: state.revert ?? null,
      snapshots: Object.keys(state.snapshots).length,
      pending: this.#pending.has(session.id),
      redoAvailable: Boolean(state.revert),
    };
  }

  /**
   * Commit when the user has queued a new turn past the revert boundary.
   *
   * Only *visible*, non-replay user messages count: the hidden originals are
   * still in the append-only log, and redo copies would otherwise look like
   * fresh input and commit a revert that is still in use.
   */
  async #commitIfSuperseded(context) {
    const state = await context.revert.state();
    if (!state.revert) return false;
    const visible = new Set(await context.port.visible());
    const superseded = context.port
      .events()
      .some(
        (event) =>
          event.type === 'user/message' &&
          event.data?.source?.kind === 'user' &&
          visible.has(event.seq) &&
          !state.copies?.[event.seq] &&
          event.seq >= state.revert.seq,
      );
    if (!superseded) return false;
    await context.revert.commit();
    return true;
  }

  #assertIdle(session) {
    if (this.#pending.has(session.id)) {
      throw new StateError('会话正在执行，请先停止再撤回');
    }
  }

  async #context(session) {
    if (!session?.id) throw new StateError('当前没有可操作的会话');
    const port = await this.#portFor(session);
    const cwd = await this.#cwdOf(session);
    if (!cwd) throw new StateError('会话没有本地工作目录');
    const snapshot = await this.#snapshotFor(cwd);
    const root = workspaceDirectory(this.#root, cwd);
    const recorder = new SnapshotRecorder({ snapshot, root, sessionId: session.id, scope: this.#scope });
    const revert = new RevertService({ snapshot, session: port, root });
    return { port, cwd, snapshot, root, recorder, revert };
  }

  async #snapshotFor(cwd) {
    if (!this.#snapshots.has(cwd)) {
      const promise = this.#openSnapshot({ worktree: cwd, root: workspaceDirectory(this.#root, cwd) }).catch((error) => {
        this.#snapshots.delete(cwd);
        throw error;
      });
      this.#snapshots.set(cwd, promise);
    }
    return this.#snapshots.get(cwd);
  }

  /** Serialize captures per worktree: the shadow index is one file. */
  async #serialized(cwd, run) {
    const previous = this.#queue.get(cwd) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => {});
    this.#queue.set(cwd, tail);
    try {
      return await next;
    } finally {
      if (this.#queue.get(cwd) === tail) this.#queue.delete(cwd);
    }
  }
}

export function defaultRewindRoot() {
  return process.env.DSH_REWIND_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'rewind');
}

export function messageText(event) {
  const content = event?.data?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}
