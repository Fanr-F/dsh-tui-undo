/**
 * Pure conversation-timeline helpers.
 *
 * The session log only holds the events that are still visible, so anything
 * that used to be cut away lives in a backup. Every read therefore merges the
 * two sources and reasons about `seq` only; nothing here touches a session.
 */

export function isUserMessage(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user';
}

export function isAssistantMessage(event) {
  return event?.type === 'assistant/message';
}

/** Merge event sources into one ascending, de-duplicated timeline. */
export function mergeTimeline(...sources) {
  const bySeq = new Map();
  for (const source of sources) {
    for (const event of source ?? []) {
      if (!event || !Number.isInteger(event.seq)) continue;
      // Earlier sources win: the live log is authoritative for its own range.
      if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
    }
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** Visible turns the user can undo to, oldest first. */
export function userMessages(timeline) {
  return timeline.filter(isUserMessage);
}

export function boundaryFor(timeline, messageID) {
  if (Number.isInteger(messageID)) return messageID;
  const match = timeline.find((event) => isUserMessage(event) && event.data?.id === messageID);
  return match?.seq;
}

/** The next turn after a boundary: redo moves the boundary forward to it. */
export function nextBoundary(timeline, boundarySeq) {
  const match = timeline.find((event) => isUserMessage(event) && event.seq > boundarySeq);
  return match?.seq;
}

export function lastBoundary(timeline) {
  return userMessages(timeline).at(-1)?.seq;
}

function snapshotAt(snapshots, seq, copies) {
  // A replay copy has a new sequence number but points at the event it copies,
  // whose snapshot is the one that describes the step's files.
  const origin = copies?.[seq] ?? seq;
  if (snapshots instanceof Map) return snapshots.get(origin);
  return snapshots?.[origin];
}

/** Original sequence behind a replay copy, or the sequence itself. */
export function originOf(seq, copies) {
  return copies?.[seq] ?? seq;
}

/**
 * Files to put back for a boundary, mapped to the `start` tree of the first
 * step that touched them after it.
 *
 * `head` is the tree captured before any undo; a step that never recorded a
 * `start` tree (pre-capture failed) contributes nothing rather than guessing.
 */
export function plan({ timeline, snapshots, boundarySeq, copies }) {
  const files = new Map();
  for (const event of timeline) {
    if (event.seq <= boundarySeq) continue;
    if (!isAssistantMessage(event)) continue;
    const snapshot = snapshotAt(snapshots, event.seq, copies);
    if (!snapshot?.start) continue;
    for (const file of snapshot.files ?? []) {
      if (!files.has(file)) files.set(file, snapshot.start);
    }
  }
  return files;
}

/** Per-file diffs recorded after a boundary, used for the confirmation panel. */
export function touchedFiles({ timeline, snapshots, boundarySeq, copies }) {
  const seen = new Set();
  const files = [];
  for (const event of timeline) {
    if (event.seq <= boundarySeq) continue;
    if (!isAssistantMessage(event)) continue;
    const snapshot = snapshotAt(snapshots, event.seq, copies);
    for (const file of snapshot?.files ?? []) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

/**
 * Everything the boundary hides: its own turn, following assistant work, and
 * the turns after it. Used to size the backup and to show the confirmation.
 */
export function hiddenRange(timeline, boundarySeq) {
  const hidden = timeline.filter((event) => event.seq >= boundarySeq);
  return {
    events: hidden,
    turns: hidden.filter(isUserMessage).length,
    steps: hidden.filter((event) => event.type === 'step/start').length,
  };
}
