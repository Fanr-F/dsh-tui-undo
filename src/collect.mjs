import { readState, writeState } from './store.mjs';

/**
 * Records per-step snapshots into the session side table.
 *
 * Capture happens before a step runs as well as after it: tools can act before
 * they report, so the `start` tree cannot be taken afterwards. A failed capture
 * is not fatal to the turn; the caller decides whether to report it.
 */
export class SnapshotRecorder {
  #snapshot;
  #root;
  #sessionId;
  #scope;
  #maxUntrackedBytes;

  constructor({ snapshot, root, sessionId, scope = '.', maxUntrackedBytes } = {}) {
    if (!snapshot || !root || !sessionId) throw new TypeError('SnapshotRecorder needs snapshot, root and sessionId');
    this.#snapshot = snapshot;
    this.#root = root;
    this.#sessionId = sessionId;
    this.#scope = scope;
    this.#maxUntrackedBytes = maxUntrackedBytes;
  }

  async record(seq) {
    const state = await readState(this.#root, this.#sessionId);
    return state.snapshots[seq];
  }

  /** Pre-capture the worktree before a step; keeps an existing start tree. */
  async begin(seq) {
    const state = await readState(this.#root, this.#sessionId);
    const existing = state.snapshots[seq];
    if (existing?.start) return existing;
    const captured = await this.#capture();
    const snapshot = { ...existing };
    if (captured) {
      snapshot.start = captured.tree;
      snapshot.end = existing?.end ?? captured.tree;
    }
    state.snapshots[seq] = snapshot;
    await writeState(this.#root, state);
    return snapshot;
  }

  /** Capture the result of a step and the files it changed. */
  async end(seq) {
    const state = await readState(this.#root, this.#sessionId);
    return this.finish(seq, state.snapshots[seq]?.start);
  }

  /**
   * Finish a step whose start tree was captured in memory before the step's
   * event existed. A missing start tree means the step cannot claim any file,
   * but its end tree is still recorded as the start for later steps.
   */
  async finish(seq, start) {
    const state = await readState(this.#root, this.#sessionId);
    const existing = state.snapshots[seq] ?? {};
    const captured = await this.#capture();
    const snapshot = { ...existing, start: start ?? existing.start };
    const uncovered = [];
    if (captured) {
      snapshot.end = captured.tree;
      uncovered.push(...captured.uncovered);
      if (!snapshot.start) snapshot.start = captured.tree;
      if (snapshot.start !== snapshot.end) {
        try {
          snapshot.files = await this.#snapshot.files(snapshot.start, snapshot.end);
        } catch {
          // A comparison failure must not poison the step; the next capture wins.
          snapshot.files = [];
        }
      } else {
        snapshot.files = [];
      }
    }
    state.snapshots[seq] = snapshot;
    await writeState(this.#root, state);
    return { snapshot, uncovered };
  }

  /** Drop a step that never produced a message. */
  async forget(seq) {
    const state = await readState(this.#root, this.#sessionId);
    if (!(seq in state.snapshots)) return false;
    delete state.snapshots[seq];
    await writeState(this.#root, state);
    return true;
  }

  async #capture() {
    return this.#snapshot.capture({ scope: this.#scope, maxUntrackedBytes: this.#maxUntrackedBytes });
  }
}
