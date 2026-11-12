/**
 * Id and position rewriting for redo copies.
 *
 * A copied conversation must not reuse durable identities: `message.id` is the
 * message's stable identity, and tool-call ids pair an assistant's `tool-call`
 * blocks with the `tool/result` messages that answer them. DSH accepts
 * duplicate ids (verified by `scripts/verify-host.mjs`, Q7), but a client that
 * keys rendered rows by id would then collapse two turns into one.
 *
 * Copies also get a **replay turn namespace**. dsh-tui keys assistant rows by
 * `turn:step`; re-appending a turn with its original numbers would update the
 * row that is already on screen instead of drawing the restored conversation.
 * Turning the copied turns into a high, monotone range keeps them separate
 * from any future live turn (`turn` is just position metadata in a durable
 * event; no turn/step boundaries are copied).
 *
 * The rewrite is pure: the original events are never mutated, and every copy
 * gets fresh ids. Usage is dropped from copies so token accounting is not
 * counted twice.
 */
import { randomUUID } from 'node:crypto';

/** First turn number a replayed copy may use; far above any live turn. */
export const REPLAY_TURN_BASE = 1_000_000;

/**
 * Rewrite one redo segment for re-append.
 *
 * @param events - hidden original events, in log order.
 * @param options.newId - id factory; injectable so tests are deterministic.
 * @param options.turnBase - first replay turn; defaults to {@link REPLAY_TURN_BASE}.
 * @returns detached `{ type, data, originSeq }` entries plus the id maps.
 */
export function rewriteForReplay(events, { newId = () => randomUUID(), turnBase } = {}) {
  const calls = new Map();
  const messages = new Map();
  const prepared = [];

  const call = (oldId) => {
    if (!calls.has(oldId)) calls.set(oldId, newId());
    return calls.get(oldId);
  };

  const turns = events.map((event) => event.data?.turn).filter((turn) => Number.isInteger(turn));
  const minTurn = turns.length > 0 ? Math.min(...turns) : 0;
  const base = Number.isSafeInteger(turnBase) ? turnBase : REPLAY_TURN_BASE;
  const turnOf = (turn) => (Number.isInteger(turn) ? base + (turn - minTurn) : turn);

  for (const event of events) {
    const data = structuredClone(event.data);
    switch (event.type) {
      case 'user/message': {
        messages.set(event.seq, data.id);
        data.id = newId();
        break;
      }
      case 'developer/message':
      case 'system/message': {
        messages.set(event.seq, data.message.id);
        data.message.id = newId();
        data.turn = turnOf(data.turn);
        break;
      }
      case 'assistant/message': {
        messages.set(event.seq, data.message.id);
        data.message.id = newId();
        data.turn = turnOf(data.turn);
        // A replay is history, not a new model call: its usage must not be
        // booked again by the token meter.
        delete data.usage;
        for (const block of data.message.content ?? []) {
          if (block?.type === 'tool-call') block.id = call(block.id);
        }
        for (const record of data.stream ?? []) {
          if (record?.type === 'tool-call-chunks' && typeof record.id === 'string') {
            record.id = call(record.id);
          } else if (record?.type === 'chunk' && record.chunk?.type === 'tool-call-delta') {
            record.chunk.id = call(record.chunk.id);
          }
        }
        break;
      }
      case 'tool/result': {
        messages.set(event.seq, data.message.id);
        const oldCall = data.message.toolCallId;
        const nextCall = call(oldCall);
        data.message.id = newId();
        data.message.toolCallId = nextCall;
        data.turn = turnOf(data.turn);
        if (data.message.source?.kind === 'tool') data.message.source.callId = nextCall;
        break;
      }
      default:
        // Not a surface message (turn/step markers never reach here in redo);
        // keep it untouched so a caller can still pass the whole segment.
        break;
    }
    prepared.push({ type: event.type, data, originSeq: event.seq });
  }

  return { events: prepared, calls, messages };
}
