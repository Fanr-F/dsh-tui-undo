/**
 * Diagnostic for a real workspace: session logs, rewind state and the shadow
 * snapshot repository.
 *
 * Run: node scripts/diagnose.mjs "d:\\Code\\git-test"
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zstdDecompressSync } from 'node:zlib';

const worktree = process.argv[2];
if (!worktree) {
  console.error('usage: node scripts/diagnose.mjs <worktree>');
  process.exit(2);
}

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.';
const rewindRoot = process.env.DSH_REWIND_HOME ?? join(HOME, '.dsh', 'rewind');
const folder = `--${worktree.replace(/:/g, '').replace(/[\\/]/g, '-')}--`;
const sessionDir = join(HOME, '.dsh', 'sessions', folder);

const workspaceKey = (path) => createHash('sha256').update(path.replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 16);
const key = workspaceKey(worktree);
const repo = join(rewindRoot, key, key, 'repo.git');

console.log(`worktree      ${worktree}`);
console.log(`session dir   ${sessionDir} ${existsSync(sessionDir) ? '' : '(missing)'}`);
console.log(`shadow repo   ${repo} ${existsSync(join(repo, 'HEAD')) ? '' : '(missing)'}`);

function readLog(path) {
  const raw = readFileSync(path);
  let text;
  try {
    text = zstdDecompressSync(raw).toString('utf8');
  } catch {
    text = raw.toString('utf8');
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

const sessions = existsSync(sessionDir)
  ? readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ id: entry.name, path: join(sessionDir, entry.name, 'session.v4.jsonl.zstd') }))
      .filter((entry) => existsSync(entry.path))
      .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
  : [];

const stateDir = join(rewindRoot, 'sessions');
const states = new Map();
if (existsSync(stateDir)) {
  for (const name of readdirSync(stateDir)) {
    try {
      const state = JSON.parse(readFileSync(join(stateDir, name), 'utf8'));
      states.set(state.sessionId, state);
    } catch {
      /* unreadable state is worth showing below, not crashing on */
    }
  }
}

for (const session of sessions.slice(0, 6)) {
  const state = states.get(session.id);
  const log = readLog(session.path);
  const commands = log.filter((row) => row.type === 'command/run' || row.type === 'command/done');
  const snapshots = state ? Object.keys(state.snapshots ?? {}).length : 0;
  console.log(`\n== ${session.id}`);
  console.log(`   events ${log.length}, snapshots ${snapshots}, undo ${(state?.undo ?? []).length}, redo ${(state?.redo ?? []).length}, journal ${state?.journal ? 'YES' : 'no'}`);
  for (const [seq, snapshot] of Object.entries(state?.snapshots ?? {})) {
    if (snapshot.files?.length) console.log(`   step ${seq}: files ${snapshot.files.join(', ')} start=${snapshot.start?.slice(0, 10)}`);
  }
  for (const row of commands) {
    const data = row.data ?? {};
    const text = row.type === 'command/run' ? `${data.name} ${data.args ?? ''}` : `${data.kind}: ${data.text ?? ''}`;
    console.log(`   seq=${row.seq} ${row.type} ${String(text).slice(0, 120)}`);
  }
  if (existsSync(join(repo, 'HEAD'))) {
    for (const snapshot of Object.values(state?.snapshots ?? {})) {
      if (!snapshot.files?.length || !snapshot.start) continue;
      for (const file of snapshot.files) {
        let body;
        try {
          body = execFileSync('git', ['--git-dir', repo, 'cat-file', '-p', `${snapshot.start}:${file}`], { encoding: 'utf8' });
        } catch {
          body = '<absent>';
        }
        console.log(`   start tree ${snapshot.start.slice(0, 10)} ${file} = ${JSON.stringify(body)}`);
      }
    }
  }
}

const logFile = join(rewindRoot, 'dsh-tui-undo.log');
console.log(`\n== plugin log ${logFile} ${existsSync(logFile) ? '' : '(missing)'}`);
if (existsSync(logFile)) {
  const lines = readFileSync(logFile, 'utf8').trimEnd().split('\n');
  console.log(lines.slice(-40).join('\n'));
}
