/**
 * Read the conversation a session currently presents.
 *
 * DSH keeps an append-only log plus a *surface*: the ordered sequence numbers
 * of the rows the model and the UI are supposed to see. Two operations matter
 * here and nothing else:
 *
 *   - `itemsOf(session)` folds the live surface into message snapshots;
 *   - `beforeSeq(session, cut)` folds the surface of a *prefix* of the log, by
 *     restoring that prefix into a detached session. That is how a replay knows
 *     what the conversation looked like at an older sequence number, without
 *     trusting (or mutating) the live surface.
 *
 * The prefix fold is stable: the log only grows, so folding `seq < cut` later
 * yields exactly the same conversation as it did when `cut` was the head.
 */

/** Surface event types that carry a message. */
export const MESSAGE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

export class HistoryError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HistoryError';
    if (cause) this.cause = cause;
  }
}

/** Whether `seq` falls inside one of the recorded ranges. */
export function hidden(ranges, seq) {
  if (!Array.isArray(ranges)) return false;
  return ranges.some((range) => seq >= range.start && seq <= range.end);
}

/** Sort, de-duplicate and coalesce touching ranges. */
export function mergeRanges(ranges) {
  const result = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = result.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else result.push({ start: range.start, end: range.end });
  }
  return result;
}

/** The message payload of one surface item, for both message shapes. */
export function messageOf(item) {
  return item.type === 'user/message' ? item.data : item.data.message;
}

/** Stable comparison key: everything about a message except its identity. */
export function signatureOf(item) {
  const { id: _id, ...rest } = messageOf(item);
  return JSON.stringify(rest);
}

/**
 * Fold a session's surface into detached message snapshots.
 *
 * `source` is the surface sequence number the message came from; a replay uses
 * it as `sourceEventSeqs` so the copy points back at the row it replayed.
 */
export function itemsOf(session) {
  const nodes = session?.surface?.nodes;
  if (!nodes) throw new HistoryError('session has no surface');
  const items = [];
  for (const seq of nodes) {
    const event = session.eventAt?.(seq);
    if (!event || !MESSAGE_EVENT_TYPES.has(event.type)) continue;
    // Our own empty hide marker is a visibility control, not conversation:
    // leaving it out keeps prefix comparison and display free of noise.
    if (event.type === 'developer/message' && event.data?.message?.source?.kind === 'dsh-tui-undo') continue;
    let message = session.surface.deriveEventMessage?.(event);
    if (!message) message = event.type === 'user/message' ? event.data : event.data?.message;
    if (!message) continue;
    const data = structuredClone(event.data);
    if (event.type === 'user/message') {
      items.push({ type: event.type, data: structuredClone(message), source: seq });
      continue;
    }
    data.message = structuredClone(message);
    // Replayed history is not a new model call: its usage must not be booked
    // again by the token meter, and the provider stream is not replayable.
    if (event.type === 'assistant/message') {
      delete data.usage;
      data.stream = [];
    }
    items.push({ type: event.type, data, source: seq });
  }
  return items;
}

/**
 * The conversation as it stood immediately before `cut`.
 *
 * `createDetached(session, events)` must return a session-like object restored
 * from `events` (see `src/host.mjs`); tests pass an in-memory equivalent.
 */
export function beforeSeq(session, cut, { createDetached } = {}) {
  if (!Number.isSafeInteger(cut) || cut < 0) throw new HistoryError('history cut must be a non-negative integer');
  if (cut > session.seq) throw new HistoryError('history cut is past the end of the log');
  if (typeof createDetached !== 'function') throw new HistoryError('history needs a detached session factory');
  const events = session.snapshotEvents().filter((event) => event.seq < cut);
  return itemsOf(createDetached(session, events));
}

/** Human turns currently on the surface, oldest first. */
export function userTargets(session) {
  return itemsOf(session)
    .filter((item) => item.type === 'user/message' && item.data?.source?.kind === 'user')
    .map((item) => ({ seq: item.source, id: item.data.id, text: textOf(item.data) }));
}

export function textOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** Index of the first message that differs between two snapshots. */
export function commonPrefix(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && signatureOf(left[index]) === signatureOf(right[index])) {
    index += 1;
  }
  return index;
}
