/**
 * Surface operations, verified against the installed dsh-session.
 *
 * DSH sessions are append-only: `seq` is always the log length, a seed can only
 * be replayed into a *detached* session, and nothing truncates a live log.
 * Visibility is controlled by `surfaceOp` markers on surface-eligible events,
 * and the surface is the sole source of derived model history.
 *
 * Consequences this module encodes:
 *   - undo appends one `developer/message` whose `surfaceOp: replace` covers the
 *     tail of the surface, with `sourceEventSeqs` listing every shadowed node;
 *   - a replace can only address nodes that are currently visible, so redo
 *     cannot "un-hide" anything: it appends copies of the hidden messages;
 *   - hidden events stay in the log, so their sequence numbers keep referring
 *     to the same content for the lifetime of the session.
 */
import { randomUUID } from 'node:crypto';
import { rewriteForReplay } from './replay.mjs';

const SURFACE_ELIGIBLE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

/** Event types that take part in the message surface. */
export const SURFACE_EVENT_TYPES = SURFACE_ELIGIBLE;

export function isSurfaceEligible(type) {
  return SURFACE_ELIGIBLE.has(type);
}

export class SurfaceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SurfaceError';
    if (cause) this.cause = cause;
  }
}

/** Sequence numbers currently on the surface, in order. */
export function surfaceNodes(session) {
  const nodes = session?.surface?.nodes;
  if (!nodes) throw new SurfaceError('session has no surface');
  return [...nodes];
}

export function lastVisibleSeq(session) {
  return surfaceNodes(session).at(-1);
}

export function isVisible(session, seq) {
  return surfaceNodes(session).includes(seq);
}

/**
 * Hide every surface node at or after `startSeq` by appending one replace op.
 *
 * Returns the hidden sequence numbers, or undefined when nothing matched (an
 * out-of-range target is a no-op rather than an error, so a retried undo cannot
 * append a pointless event).
 */
export function hideFrom(session, { startSeq, turn, step, message } = {}) {
  if (!Number.isSafeInteger(startSeq)) throw new SurfaceError('hideFrom needs an integer startSeq');
  const nodes = surfaceNodes(session);
  const covered = nodes.filter((seq) => seq >= startSeq);
  if (covered.length === 0) return undefined;
  const counters = turnStep(session);
  session.append(
    'developer/message',
    {
      turn: Number.isSafeInteger(turn) ? turn : counters.turn,
      step: Number.isSafeInteger(step) ? step : counters.step,
      message: message ?? {
        // Message ids are durable identities (and UI keys), so every hiding
        // marker gets its own: undoing the same range twice must not collide.
        id: `dsh-tui-undo:hide:${covered[0]}-${covered.at(-1)}:${randomUUID()}`,
        role: 'developer',
        source: { kind: 'dsh-tui-undo' },
        content: [],
      },
    },
    {
      surfaceOp: { op: 'replace', startSeq: covered[0], endSeq: covered.at(-1) },
      sourceEventSeqs: covered,
    },
  );
  return covered;
}

/**
 * Make one hidden event visible again by appending a copy.
 *
 * The caller owns id rewriting: DSH message and tool-call ids are unique per
 * session, and a replay must keep tool calls and their results paired.
 */
export function showCopy(session, event, { data = event?.data } = {}) {
  if (!event?.type) throw new SurfaceError('showCopy needs an event');
  if (!SURFACE_ELIGIBLE.has(event.type)) {
    throw new SurfaceError(`${event.type} is not a surface event and cannot be shown`);
  }
  const opts = { surfaceOp: 'append' };
  // assistant/message embeds its provider stream and rejects sourceEventSeqs.
  if (event.type !== 'assistant/message' && Number.isSafeInteger(event.seq)) opts.sourceEventSeqs = [event.seq];
  const logged = session.append(event.type, structuredClone(data), opts);
  return logged;
}

/**
 * Whether this host exposes dsh 0.2.2-rc.2's batch append.
 *
 * The batch overload landed in rc.2 together with the
 * `currentBatchPublication` getter, which is a safe read-only probe: rc.1
 * neither accepts an array in `append` nor publishes that property.
 */
export function supportsBatchAppend(session) {
  return Boolean(session) && 'currentBatchPublication' in session;
}

/**
 * Make several hidden events visible again in one commit.
 *
 * On rc.2 every copied event is validated before the log grows and the whole
 * batch becomes visible with one surface fold, so a multi-message redo cannot
 * flash a half-restored conversation or trigger one flush per event.
 *
 * `rewrite` gives every copied message (and every tool call) a fresh id, so a
 * replayed turn is a new durable identity rather than a duplicate of a hidden
 * original; see `src/replay.mjs`.
 */
export function showCopies(session, events, { rewrite = false, newId } = {}) {
  const prepared = rewrite
    ? rewriteForReplay(events, { newId }).events
    : [...events].map((event) => ({ type: event.type, data: event.data, originSeq: event.seq }));
  const inputs = prepared.map((event) => [
    event.type,
    structuredClone(event.data),
    {
      surfaceOp: 'append',
      ...(event.type !== 'assistant/message' && Number.isSafeInteger(event.originSeq)
        ? { sourceEventSeqs: [event.originSeq] }
        : {}),
    },
  ]);
  if (!inputs.length) return [];
  if (supportsBatchAppend(session)) {
    const logged = session.append(inputs);
    return Array.isArray(logged) ? logged : [];
  }
  return inputs.map(([type, data, opts]) => session.append(type, data, opts));
}

/** Latest turn/step numbers, used for developer messages that hide a range. */
export function turnStep(session) {
  const events = session.snapshotEvents?.() ?? [];
  let turn = 0;
  let step = 0;
  for (const event of events) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn;
    if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) step = event.data.step;
  }
  return { turn, step };
}
