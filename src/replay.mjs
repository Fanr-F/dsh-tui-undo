/**
 * Id rewriting for redo copies.
 *
 * A copied conversation must not reuse durable identities: `message.id` is the
 * message's stable identity, and tool-call ids pair an assistant's `tool-call`
 * blocks with the `tool/result` messages that answer them. DSH accepts
 * duplicate ids (verified by `scripts/verify-host.mjs`, Q7), but a client that
 * keys rendered rows by id would then collapse two turns into one.
 *
 * The rewrite is pure: the original events are never mutated, and every copy
 * gets fresh ids. A redo segment always starts at a user message and therefore
 * contains whole turns, so an assistant's tool calls and their results live in
 * the same segment and can be remapped together.
 */
import { randomUUID } from 'node:crypto';

/**
 * Rewrite one redo segment for re-append.
 *
 * @param events - hidden original events, in log order.
 * @param options.newId - id factory; injectable so tests are deterministic.
 * @returns detached `{ type, data, originSeq }` entries plus the id maps.
 */
export function rewriteForReplay(events, { newId = () => randomUUID() } = {}) {
  const calls = new Map();
  const messages = new Map();
  const prepared = [];

  const call = (oldId) => {
    if (!calls.has(oldId)) calls.set(oldId, newId());
    return calls.get(oldId);
  };

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
        break;
      }
      case 'assistant/message': {
        messages.set(event.seq, data.message.id);
        data.message.id = newId();
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
