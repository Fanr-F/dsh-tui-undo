/**
 * Pre-commit proof that a replay still reloads.
 *
 * DSH persists sessions through a strict format catalog; a log the catalog
 * rejects is a session the user can no longer open. Every replay is therefore
 * decoded by the *host's own* catalog (and handed back to `Session.create`)
 * before a single byte is appended.
 */
import { HistoryError } from './history.mjs';

/**
 * Build the validator the replay builder expects.
 *
 * Returns `undefined` when the host cannot provide a catalog: undo still works,
 * it just loses the belt-and-braces reload check.
 */
export function createValidator({ Session, catalog, projections = [] } = {}) {
  if (!catalog?.encodeCurrentHeader || !catalog?.createRestore) return undefined;
  return function validate(session) {
    const header = catalog.encodeCurrentHeader(
      {
        ...session.header,
        isSeeded: session.header?.isSeeded ?? false,
        delegationDepth: session.header?.delegationDepth ?? 0,
      },
      session.inheritedEventCount ?? 0,
    );
    const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' });
    try {
      for (const event of session.snapshotEvents()) {
        restore.decodeRow(catalog.encodeCurrentEvent(event));
      }
      restore.finish();
    } catch (error) {
      throw new HistoryError(`重放后的日志没有通过格式校验：${error.message}`, error);
    }
    if (typeof Session?.create === 'function' || typeof session?.constructor?.create === 'function') {
      const Constructor = typeof session?.constructor?.create === 'function' ? session.constructor : Session;
      try {
        Constructor.create(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount ?? 0, projections);
      } catch (error) {
        throw new HistoryError(`重放后的日志无法重新打开：${error.message}`, error);
      }
    }
    return true;
  };
}

/**
 * Detached session factory used to fold a log prefix.
 *
 * The live session's own class is preferred: a `link:`-installed plugin may
 * resolve a second copy of `@deepseek-ai/dsh-session` from another profile, and
 * a foreign class would make identity checks disagree with the host. A prefix
 * of a live session was already validated, so `eventState: 'shared-frozen'`
 * lets it share the events instead of deep-copying them.
 */
export function createDetachedFactory(Session, projections = []) {
  return function createDetached(session, events) {
    const Constructor = typeof session?.constructor?.fromRestore === 'function' ? session.constructor : Session;
    if (typeof Constructor?.fromRestore !== 'function') {
      throw new HistoryError('host session cannot restore a detached prefix');
    }
    return Constructor.fromRestore(
      session.id,
      events,
      session.header,
      Math.min(session.inheritedEventCount ?? 0, events.length),
      'shared-frozen',
      projections,
    );
  };
}
