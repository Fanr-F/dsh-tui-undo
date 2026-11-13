/**
 * Build a replay of a conversation *inside an open turn and step*.
 *
 * This is the whole difference between v5 and v6. A durable dsh log validates
 * turn/step ownership (`@deepseek-ai/dsh-session-format-v3-to-v4` requires every
 * `developer/message`, `assistant/message`, `tool/call` and `tool/result` to sit
 * in an open turn+step, and `turn/start` to be exactly the next turn number), so
 * a message appended after `turn/end` makes the session unreloadable.
 *
 * The runtime therefore borrows a real maintenance turn from the agent
 * (`agent.runMaintenance()` + a steer marker) and calls this module from
 * `agent/pre-step`, where the turn is open but no step exists yet. Everything
 * this module returns is appended before the host loop appends `turn/end`.
 *
 * Construction rules:
 *   1. a detached clone receives the events, so a rejected replay costs nothing;
 *   2. `step/start` opens the borrowed step;
 *   3. the *tail* of the current surface is hidden with one empty
 *      `developer/message` replace marker (the only visibility primitive);
 *   4. the desired messages are copied with fresh message ids and fresh
 *      tool-call ids, `tool/call` rows are re-created for each call, assistant
 *      `usage` is dropped, and every copy points at its origin;
 *   5. `step/end` closes the step; the host loop appends `turn/end` itself.
 */
import { randomUUID } from 'node:crypto';
import { itemsOf, messageOf, commonPrefix } from './history.mjs';

export class ReplayError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ReplayError';
    if (cause) this.cause = cause;
  }
}

/**
 * Build the events that replay `desired` in `turn`/`step`.
 *
 * @param session - the live session (only read).
 * @param desired - message snapshots from `history.beforeSeq`.
 * @param options.turn - the open maintenance turn.
 * @param options.step - the step number to open (1 for a fresh turn).
 * @param options.createDetached - `(session, events) => session-like`.
 * @param options.validate - `(detachedSession) => void`; may throw.
 * @returns `{ events, hidden }` — `events` still excludes `turn/end`.
 */
export function buildReplay(session, desired, { turn, step = 1, createDetached, validate, newId = randomUUID } = {}) {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new ReplayError('replay needs the open turn number');
  if (!Number.isSafeInteger(step) || step < 1) throw new ReplayError('replay needs a positive step number');
  if (typeof createDetached !== 'function') throw new ReplayError('replay needs a detached session factory');
  if (!Array.isArray(desired)) throw new ReplayError('replay needs a message snapshot');

  const clone = createDetached(session, session.snapshotEvents());
  // Two sequence spaces: the clone (a restored seed) may carry an extra
  // `session/end-seed` row, so its numbering can be one ahead of the live log.
  // Surface *contents* are identical, but everything this module reports to the
  // runtime (event seqs, the hide marker, the copy map) must be live-space.
  const cloneStart = clone.seq;
  const liveStart = session.seq;
  const toLive = (cloneSeq) => liveStart + (cloneSeq - cloneStart);
  clone.append('step/start', { turn, step });

  const current = itemsOf(session);
  const common = commonPrefix(desired, current);
  const nodes = [...clone.surface.nodes];
  const keptSeq = common > 0 ? current[common - 1].source : -1;
  const tail = nodes.filter((seq) => seq > keptSeq);

  // Tool-call ids of the *kept* prefix stay valid; only later calls are new.
  const calls = new Map();
  for (const item of desired.slice(0, common)) {
    for (const block of messageOf(item).content ?? []) {
      if (block?.type === 'tool-call') calls.set(block.id, block.id);
    }
  }

  const copy = structuredClone(desired.slice(common));
  const copies = [];

  // The system prompt opens the surface and carries the model's instructions;
  // when the tail reaches it, replace it in place instead of hiding it.
  const head = tail.length > 0 && tail[0] === nodes[0] && clone.eventAt(tail[0])?.type === 'system/message' ? tail.shift() : undefined;
  if (head !== undefined) {
    const system = copy[0]?.type === 'system/message' ? copy.shift() : null;
    const message = system
      ? system.data.message
      : { id: newId(), role: 'system', source: { kind: 'system-prompt' }, content: [] };
    clone.append(
      'system/message',
      { turn, step, message },
      { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] },
    );
  }

  const hidden = tail.length > 0 ? { start: tail[0], end: tail.at(-1) } : null;
  let marker;
  if (tail.length > 0) {
    marker = clone.seq;
    clone.append(
      'developer/message',
      { turn, step, message: { id: newId(), role: 'developer', source: { kind: 'dsh-tui-undo' }, content: [] } },
      { surfaceOp: { op: 'replace', startSeq: tail[0], endSeq: tail.at(-1) }, sourceEventSeqs: tail },
    );
  }

  // Fresh identities first, so a tool result can be re-pointed at the copy of
  // the call that produced it.
  for (const item of copy) {
    const message = messageOf(item);
    message.id = newId();
    for (const block of message.content ?? []) {
      if (block?.type !== 'tool-call') continue;
      const fresh = `undo_${newId().replaceAll('-', '')}`;
      calls.set(block.id, fresh);
      block.id = fresh;
    }
    if (message.role === 'tool') {
      if (!calls.has(message.toolCallId)) {
        throw new ReplayError('这段历史里有找不到对应工具调用的结果，无法安全重放');
      }
      message.toolCallId = calls.get(message.toolCallId);
      if (message.source?.callId) message.source.callId = message.toolCallId;
    }
  }

  for (const item of copy) {
    const data = structuredClone(item.data);
    // Copy rows are tagged with the borrowed step: the durable log has no
    // "which step did this belong to" concept for replayed history.
    if (item.type !== 'user/message') {
      data.turn = turn;
      data.step = step;
    }
    const options = { surfaceOp: 'append' };
    // assistant/message embeds its provider stream and rejects sourceEventSeqs.
    if (item.type !== 'assistant/message' && Number.isSafeInteger(item.source)) {
      options.sourceEventSeqs = [item.source];
    }
    clone.append(item.type, data, options);
    // The copy owns a new sequence number but describes the same step as its
    // origin: remember the mapping so the file plan can find that step later.
    if (Number.isSafeInteger(item.source)) {
      copies.push({ seq: clone.seq - 1, origin: item.source });
    }
    // A tool result must have a logged call lifecycle; the original call row is
    // part of the replayed turn now, so it is re-created next to the copy.
    if (item.type === 'assistant/message') {
      for (const block of data.message.content ?? []) {
        if (block?.type !== 'tool-call') continue;
        clone.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments });
      }
    }
  }

  clone.append('step/end', { turn, step });
  const prepared = clone.snapshotEvents().slice(cloneStart).map((event, index) => ({
    ...event,
    seq: liveStart + index,
  }));
  const liveCopies = copies.map((entry) => ({ seq: toLive(entry.seq), origin: entry.origin }));

  // Prove the result decodes before the runtime commits anything: a rejected
  // replay must leave the worktree and the log untouched.
  clone.append('turn/end', { turn, reason: { kind: 'blocked' } });
  if (typeof validate === 'function') validate(clone);
  return { events: prepared, hidden, copies: liveCopies, marker: Number.isSafeInteger(marker) ? toLive(marker) : marker };
}
