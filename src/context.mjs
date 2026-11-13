/**
 * Record what the plugin sees being submitted to the model.
 *
 * The rewind itself never calls a model, but it changes the *surface* the next
 * step is assembled from. This module turns the `agent/pre-step` message list
 * into one readable JSONL record per session, so `/undo-context` can answer
 * "what exactly would the model receive now?" without a debugger.
 *
 * Logging is best effort: a failed write never affects the step.
 */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionKey } from './paths.mjs';

const DEFAULT_LIMIT = 8000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const SUMMARY_CHARS = 2000;

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text);

function textOfResult(block) {
  const content = block?.content ?? block?.result ?? block?.output;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content ?? '') ?? '';
  } catch {
    return '';
  }
}

/** One message as role plus a plain-text body, clipped for the log. */
export function describeMessage(message, { limit = DEFAULT_LIMIT } = {}) {
  const role = typeof message?.role === 'string' ? message.role : 'unknown';
  const content = message?.content;
  const blocks = Array.isArray(content)
    ? content
    : content === undefined || content === null
      ? []
      : [{ type: 'text', text: String(content) }];
  const parts = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    switch (block?.type) {
      case 'text':
        parts.push(String(block.text ?? ''));
        break;
      case 'reasoning':
        parts.push(`[reasoning] ${String(block.text ?? '')}`);
        break;
      case 'tool-call':
        parts.push(`[tool-call ${block.name ?? '?'}] ${safeJson(block.arguments ?? block.input)}`);
        break;
      case 'tool-result':
        parts.push(`[tool-result] ${textOfResult(block)}`);
        break;
      case 'image':
        parts.push('[image]');
        break;
      default:
        parts.push(block?.type ? `[${block.type}]` : '[block]');
    }
  }
  const text = clip(parts.filter(Boolean).join('\n'), limit);
  return { role, chars: text.length, text, ...(message?.id !== undefined ? { id: String(message.id) } : {}) };
}

function safeJson(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Summarise one model input.
 *
 * @returns `{ count, chars, roles, messages }`, where each message is
 * `{ role, chars, text }`. The caller adds turn/seq/time.
 */
export function describeInput(messages, { limit = DEFAULT_LIMIT } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const described = list.map((message) => describeMessage(message, { limit }));
  const chars = described.reduce((total, item) => total + item.chars, 0);
  return {
    count: described.length,
    chars,
    roles: described.map((item) => item.role),
    messages: described,
  };
}

/** The role a surface item contributes to the model input. */
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
};

/**
 * Describe the conversation a session currently presents to the model.
 *
 * `items` are the surface items `history.itemsOf()` folds: this is the part of
 * the request the host derives from the session log, so it is what an undo
 * actually rewrites. Tool schemas and provider-level additions are not here.
 */
export function describeSurface(items, { limit = DEFAULT_LIMIT } = {}) {
  const messages = [];
  for (const item of Array.isArray(items) ? items : []) {
    const message = item?.data?.message ?? item?.data;
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : ROLE_BY_TYPE[item?.type];
    if (!role) continue;
    messages.push({ ...message, role });
  }
  return describeInput(messages, { limit });
}

/** A short, single-line preview of a described input for the diagnostic log. */
export function summarizeInput(described) {
  const head = described.messages.slice(0, 6).map((item) => `${item.role}:${item.chars}`);
  const tail = described.messages.slice(6).length;
  const text = `messages=${described.count} chars=${described.chars} roles=${head.join(',')}${tail > 0 ? `, +${tail}` : ''}`;
  return clip(text, SUMMARY_CHARS);
}

/**
 * Append-only per-session context log.
 *
 * @param directory - where the JSONL files live (one per session).
 * @param limit - characters kept per message.
 * @param maxBytes - the file is rotated to `.1` once it grows past this.
 */
export function createContextLog({ directory, limit = DEFAULT_LIMIT, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!directory) throw new TypeError('createContextLog needs a directory');
  const lastBySession = new Map();
  const chains = new Map();
  const bytes = new Map();

  const pathOf = (sessionId) => join(directory, `${sessionKey(sessionId)}.jsonl`);

  const write = (sessionId, entry) => {
    const path = pathOf(sessionId);
    lastBySession.set(sessionId, entry);
    const line = `${JSON.stringify(entry)}\n`;
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await mkdir(directory, { recursive: true });
        if (!bytes.has(path)) bytes.set(path, await stat(path).then((info) => info.size, () => 0));
        await appendFile(path, line, 'utf8');
        const size = (bytes.get(path) ?? 0) + Buffer.byteLength(line);
        if (size > maxBytes) {
          bytes.set(path, 0);
          await rename(path, `${path}.1`).catch(() => {});
        } else {
          bytes.set(path, size);
        }
      } catch {
        /* the recorder must never break the step it observes */
      }
    });
    chains.set(sessionId, next);
    return next;
  };

  const readLast = async (sessionId) => {
    const cached = lastBySession.get(sessionId);
    if (cached) return cached;
    try {
      const text = await readFile(pathOf(sessionId), 'utf8');
      const line = text.trimEnd().split('\n').at(-1);
      if (!line) return null;
      const parsed = JSON.parse(line);
      lastBySession.set(sessionId, parsed);
      return parsed;
    } catch {
      return null;
    }
  };

  return {
    directory,
    limit,
    pathOf,
    write,
    last: readLast,
    async flush() {
      await Promise.all([...chains.values()]).catch(() => {});
    },
  };
}
