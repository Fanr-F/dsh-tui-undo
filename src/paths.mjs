import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Stable key for one worktree inside the rewind store. */
export function workspaceKey(worktree) {
  return createHash('sha256').update(worktree.replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 16);
}

export function sessionKey(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
}

export function workspaceDirectory(root, worktree) {
  return join(root, workspaceKey(worktree));
}

export function sessionStatePath(root, sessionId) {
  return join(root, 'sessions', `${sessionKey(sessionId)}.json`);
}

export function lockPath(root) {
  return join(root, 'locks', 'workspace.lock');
}
