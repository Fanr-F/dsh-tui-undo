import { StateError, acquireLock, readState, writeState } from './store.mjs';
import { isUserMessage, nextBoundary, plan, touchedFiles, userMessages } from './timeline.mjs';
import { isSurfaceEligible } from './surface.mjs';
import { REPLAY_TURN_BASE } from './replay.mjs';

/**
 * Undo / redo over one session, built on surface replacement.
 *
 * DSH logs are append-only (verified against the installed dsh 0.2.2-rc.2), so
 * nothing is ever removed: `undo` appends one `developer/message` whose
 * `surfaceOp: replace` hides the tail, and `redo` re-appends copies of the
 * hidden messages. The original events stay in the log forever, which is what
 * keeps the snapshot index (`snapshots[seq]`) valid across redos.
 *
 * Two sequence spaces coexist:
 * - the *visible* sequence number, which a redo copy owns after it is appended;
 * - the *origin* sequence number of the hidden event it replays.
 *
 * Every user-facing target is a visible sequence; `state.copies` maps a copy
 * back to its origin so file plans can still find the step snapshot. A copy's
 * origin is only replayable again once the copy itself has been hidden, which
 * is what keeps a redo→undo→redo cycle from duplicating conversation.
 *
 * Ports:
 * - `snapshot`: capture/files/diff/restore (the shadow git store);
 * - `session`: events/visible/hideFrom/showCopies (see `src/host.mjs`).
 */
export class RevertService {
  #snapshot;
  #session;
  #root;

  constructor({ snapshot, session, root }) {
    if (!snapshot || !session || !root) throw new TypeError('RevertService needs snapshot, session and root');
    this.#snapshot = snapshot;
    this.#session = session;
    this.#root = root;
  }

  async state() {
    return readState(this.#root, this.#session.id);
  }

  /** Undo targets: human turns currently visible, oldest first. */
  async targets() {
    const state = await this.state();
    const { timeline, visible } = await this.#view(state);
    return userMessages(timeline)
      .filter((event) => visible.has(event.seq))
      .map((event) => ({
        messageID: event.data.id,
        seq: event.seq,
        originSeq: state.copies?.[event.seq] ?? event.seq,
        hidden: hiddenOnSurface(timeline, visible, event.seq),
      }));
  }

  /** What an undo to `target` would do, without touching anything. */
  async preview(target) {
    const state = await this.state();
    const { timeline, visible } = await this.#view(state);
    const boundarySeq = resolveVisibleTarget(timeline, visible, target);
    const origin = state.copies?.[boundarySeq] ?? boundarySeq;
    const paths = touchedFiles({ timeline, snapshots: state.snapshots, boundarySeq: origin, copies: state.copies });
    const files = plan({ timeline, snapshots: state.snapshots, boundarySeq: origin, copies: state.copies });
    return {
      messageID: messageIdAt(timeline, boundarySeq) ?? String(boundarySeq),
      boundarySeq,
      hidden: hiddenOnSurface(timeline, visible, boundarySeq),
      paths,
      files: [...files.keys()],
      reverted: Boolean(state.revert),
    };
  }

  /**
   * Hide everything from `seq` (or the visible message with `messageID`) on.
   *
   * The surface append happens first: a rejected append must leave the
   * worktree untouched, because the log is the durable commitment.
   */
  async undo({ messageID, seq, files = true }) {
    return this.#locked(async () => {
      const state = await this.state();
      const { timeline, visible } = await this.#view(state);
      const boundarySeq = resolveVisibleTarget(timeline, visible, seq ?? messageID);
      const origin = state.copies?.[boundarySeq] ?? boundarySeq;
      // Conversation-only undo must not require git: only a file undo captures
      // the worktree and looks for a head tree to diff against.
      const original = files ? (state.revert?.snapshot ?? (await this.#capture())) : state.revert?.snapshot;
      const restore = this.#restorePlan({ state, timeline, boundarySeq: origin, files, original });

      const hidden = await this.#session.hideFrom(boundarySeq);
      if (!hidden?.length) throw new StateError('没有可回退的对话内容');
      const generation = await this.#session.generation?.();
      const restored = restore.size ? await this.#snapshot.restore(restore) : undefined;
      const diff = original && restore.size ? await this.#diff(original, [...restore.keys()]) : [];

      const persisted = await writeState(this.#root, {
        ...state,
        revert: {
          messageID: messageIdAt(timeline, boundarySeq) ?? String(boundarySeq),
          seq: origin,
          snapshot: original,
          files: diff,
          surface: generation,
        },
      });
      return {
        done: true,
        boundarySeq,
        hidden: { events: hidden.length, turns: hiddenOnSurface(timeline, visible, boundarySeq).turns },
        files: diff,
        restore: restored,
        state: persisted,
      };
    });
  }

  /** Move the boundary forward by one turn, or bring everything back. */
  async redo({ files = true } = {}) {
    return this.#locked(async () => {
      const state = await this.state();
      if (!state.revert) return { done: false, reason: 'nothing to redo' };
      const { timeline, visible } = await this.#view(state);
      const boundary = state.revert.seq;
      const original = state.revert.snapshot;
      this.#assertSurfaceUnchanged(state, await this.#session.generation?.());
      const replayable = replayableEvents(timeline, visible, state.copies);
      const next = nextBoundary(replayable, boundary);

      const restore = new Map();
      if (files && original) {
        for (const entry of state.revert.files) restore.set(entry.file, original);
      }
      if (files && next !== undefined) {
        // The plan wins over the head fallback above: files still touched after
        // the new boundary must be restored to that boundary, not to the head
        // captured when the undo started.
        for (const [file, tree] of plan({ timeline, snapshots: state.snapshots, boundarySeq: next, copies: state.copies })) {
          restore.set(file, tree);
        }
      }

      const segment = replayable.filter(
        (event) =>
          event.seq >= boundary &&
          event.seq < (next ?? Number.POSITIVE_INFINITY) &&
          isSurfaceEligible(event.type) &&
          !visible.has(event.seq),
      );
      const copies = segment.length
        ? await this.#session.showCopies(segment, {
            rewrite: true,
            // Keep copied turns clear of the live turn counter (and of earlier
            // replay turns), so a transcript keyed by turn:step draws new rows.
            turnBase: REPLAY_TURN_BASE + maxTurnOf(timeline),
          })
        : [];
      const mapping = { ...(state.copies ?? {}) };
      copies.forEach((event, index) => {
        mapping[event.seq] = segment[index].seq;
      });

      const restored = restore.size ? await this.#snapshot.restore(restore) : undefined;
      const diff = original && next !== undefined ? await this.#diff(original, [...restore.keys()]) : [];
      const persisted = await writeState(this.#root, {
        ...state,
        copies: mapping,
        revert:
          next === undefined
            ? undefined
            : {
                messageID: messageIdAt(timeline, next) ?? String(next),
                seq: next,
                snapshot: original,
                files: diff,
                surface: state.revert.surface,
              },
      });
      return {
        done: true,
        cleared: next === undefined,
        boundarySeq: next,
        replayed: copies.length,
        files: diff,
        restore: restored,
        state: persisted,
      };
    });
  }

  /** Keep the current view; redo stops being possible. Nothing is deleted. */
  async commit() {
    return this.#locked(async () => {
      const state = await this.state();
      if (!state.revert) return { done: false };
      await writeState(this.#root, { ...state, revert: undefined });
      return { done: true, committedTo: state.revert.messageID };
    });
  }

  /**
   * Reject a redo after something else rewrote the surface (typically
   * compaction). Replaying a hidden segment computed from a stale surface
   * would restore the wrong rows, so fail closed instead.
   */
  #assertSurfaceUnchanged(state, current) {
    const previous = state.revert?.surface;
    if (!previous || !current) return;
    if (
      previous.replaceGeneration !== current.replaceGeneration ||
      previous.contentGeneration !== current.contentGeneration
    ) {
      throw new StateError('对话已被压缩或改写，无法继续重做');
    }
  }

  #restorePlan({ state, timeline, boundarySeq, files, original }) {
    const restore = new Map();
    if (!files) return restore;
    if (state.revert && original) {
      for (const entry of state.revert.files) restore.set(entry.file, original);
    }
    for (const [file, tree] of plan({ timeline, snapshots: state.snapshots, boundarySeq, copies: state.copies })) {
      restore.set(file, tree);
    }
    return restore;
  }

  async #view(state) {
    const timeline = this.#session.events();
    const visible = new Set(await this.#session.visible());
    return { timeline, visible };
  }

  async #capture() {
    const captured = await this.#snapshot.capture();
    return captured?.tree;
  }

  async #diff(original, paths) {
    const head = (await this.#capture()) ?? original;
    if (head === original) return [];
    return this.#snapshot.diff(original, head, { paths });
  }

  async #locked(run) {
    const lock = await acquireLock(this.#root, { owner: this.#session.id });
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }
}

/** Resolve a visible sequence or a message id to the visible sequence to hide. */
function resolveVisibleTarget(timeline, visible, target) {
  if (Number.isSafeInteger(target)) {
    if (!visible.has(target)) throw new StateError('这条消息已经不在当前对话中');
    return target;
  }
  if (typeof target === 'string') {
    const matches = timeline.filter((event) => isUserMessage(event) && event.data?.id === target);
    const pick = matches.filter((event) => visible.has(event.seq)).at(-1);
    if (!pick) {
      throw new StateError(matches.length ? '这条消息已经不在当前对话中' : `unknown message ${target}`);
    }
    return pick.seq;
  }
  throw new StateError('没有指定要回退的消息');
}

/** Hidden tail as the user sees it: currently visible surface events. */
function hiddenOnSurface(timeline, visible, fromSeq) {
  const hidden = timeline.filter(
    (event) => visible.has(event.seq) && event.seq >= fromSeq && !isUndoMarker(event),
  );
  return {
    events: hidden.length,
    turns: hidden.filter(isUserMessage).length,
    steps: hidden.filter((event) => event.type === 'step/start').length,
  };
}

/** The empty developer message an undo appends is a marker, not conversation. */
function isUndoMarker(event) {
  return event.type === 'developer/message' && event.data?.message?.source?.kind === 'dsh-tui-undo';
}

/**
 * Original events a redo may still bring back.
 *
 * - a visible event is already on the surface;
 * - a copy is a replay, never replayed again;
 * - an original whose copy is visible is already restored, so replaying it
 *   would duplicate the conversation.
 */
function replayableEvents(timeline, visible, copies) {
  const restored = new Set();
  for (const seq of visible) {
    restored.add(seq);
    restored.add(copies?.[seq] ?? seq);
  }
  return timeline.filter(
    (event) =>
      !visible.has(event.seq) &&
      !copies?.[event.seq] &&
      !restored.has(event.seq) &&
      !isUndoMarker(event),
  );
}

function messageIdAt(timeline, seq) {
  const event = timeline.find((candidate) => candidate.seq === seq);
  return event?.data?.id;
}

/** Highest turn number anywhere in the log (including earlier replay copies). */
function maxTurnOf(timeline) {
  let max = 0;
  for (const event of timeline) {
    const turn = event.data?.turn;
    if (Number.isInteger(turn) && turn > max) max = turn;
  }
  return max;
}
