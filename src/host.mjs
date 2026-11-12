/**
 * Host adapter: binds one live DSH session to the ports `RevertService` uses.
 *
 * DSH sessions are append-only (verified against the installed dsh-session and
 * by `scripts/verify-host.mjs`), so there is no log rewrite here: visibility is
 * controlled by `surfaceOp` markers, which `src/surface.mjs` appends.
 */
import { hideFrom, showCopies, surfaceNodes } from './surface.mjs';

export class HostError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HostError';
    if (cause) this.cause = cause;
  }
}

/** True when the object looks like a live DSH session we can drive. */
export function canDrive(session) {
  return Boolean(
    session &&
      typeof session.append === 'function' &&
      typeof session.snapshotEvents === 'function' &&
      session.surface &&
      Array.isArray(session.surface.nodes),
  );
}

export function describeHost(session) {
  const missing = [];
  if (typeof session?.append !== 'function') missing.push('append');
  if (typeof session?.snapshotEvents !== 'function') missing.push('snapshotEvents');
  if (!session?.surface || !Array.isArray(session.surface.nodes)) missing.push('surface');
  return { canDrive: missing.length === 0, missing };
}

/**
 * The port `RevertService` expects.
 *
 * `events()` returns the whole log (hidden events included) because sequence
 * numbers never change; `visible()` reports the current surface so the service
 * can tell hidden originals from replay copies.
 */
export function createSurfacePort({ session }) {
  if (!canDrive(session)) {
    throw new HostError(`this host cannot drive a session surface (missing ${describeHost(session).missing.join(', ')})`);
  }
  return {
    id: session.id,
    header: () => session.header,
    events: () => structuredClone(session.snapshotEvents()),
    visible: () => surfaceNodes(session),
    generation: () => ({
      replaceGeneration: session.surface.replaceGeneration,
      contentGeneration: session.surface.contentGeneration,
    }),
    hideFrom: (startSeq) => hideFrom(session, { startSeq }),
    showCopies: (events, options) => showCopies(session, events, options),
  };
}
