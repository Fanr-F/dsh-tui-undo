/**
 * The plugin's own diagnostic log.
 *
 * A rejected replay is hard to explain from the outside: the interesting state
 * (which turn was borrowed, what the file plan held, which sequence numbers the
 * append saw) only exists during the maintenance turn. Writing it next to the
 * rewind store means the user can hand over one file instead of a transcript,
 * and `scripts/diagnose.mjs` can read it without a running host.
 *
 * Logging must never influence the operation: every write is best effort and a
 * failure is swallowed. The file is rotated once it grows past `limit`.
 */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_LIMIT = 512 * 1024;
const DATA_LIMIT = 600;

function stringify(data) {
  try {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return text.length > DATA_LIMIT ? `${text.slice(0, DATA_LIMIT)}…` : text;
  } catch {
    return '<unserializable>';
  }
}

export function createLog({ file, limit = DEFAULT_LIMIT } = {}) {
  if (!file) return noop();
  let chain = Promise.resolve();
  let bytes = 0;
  let known = false;

  const write = (scope, message, data) => {
    const line = `${new Date().toISOString()} ${String(scope).padEnd(9)} ${message}${data === undefined ? '' : ` ${stringify(data)}`}\n`;
    chain = chain.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        if (!known) {
          known = true;
          bytes = await stat(file).then((info) => info.size, () => 0);
        }
        await appendFile(file, line, 'utf8');
        bytes += Buffer.byteLength(line);
        if (bytes > limit) {
          bytes = 0;
          await rename(file, `${file}.1`).catch(() => {});
        }
      } catch {
        /* a diagnostic log must never break the operation it describes */
      }
    });
    return chain;
  };

  return {
    file,
    write,
    async flush() {
      await chain.catch(() => {});
    },
    async tail(lines = 20) {
      try {
        const text = await readFile(file, 'utf8');
        return text.trimEnd().split('\n').slice(-lines).join('\n');
      } catch {
        return '';
      }
    },
  };
}

function noop() {
  return { file: null, write() {}, async flush() {}, async tail() { return ''; } };
}

/** Truncate an error for a log line while keeping the first useful frame. */
export function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const frame = (error.stack ?? '').split('\n')[1]?.trim();
  return { message: error.message, ...(frame ? { frame } : {}) };
}
