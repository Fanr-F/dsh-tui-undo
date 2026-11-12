import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export class GitError extends Error {
  constructor({ args, code, stdout, stderr, cause, timeout }) {
    const detail = stderr.trim() || cause?.message || 'unknown failure';
    super(
      timeout
        ? `git ${args.join(' ')} timed out after ${timeout}ms`
        : `git ${args.join(' ')} failed${code === null ? '' : ` with exit code ${code}`}: ${detail}`,
    );
    this.name = 'GitError';
    this.args = args;
    this.exitCode = code;
    this.stdout = stdout;
    this.stderr = stderr;
    if (cause) this.cause = cause;
  }
}

/**
 * Run git without stdio pipes.
 *
 * The DSH sandbox denies pipe creation to child processes on Windows
 * (`spawn EPERM`), so stdout, stderr and stdin are regular files handed to
 * `spawn` as descriptors. File redirection also keeps output off the pipe
 * buffer, which removes the maxBuffer ceiling from big diffs.
 */
export async function git(args, options = {}) {
  const {
    cwd,
    env,
    timeout = DEFAULT_TIMEOUT,
    maxOutput = DEFAULT_MAX_OUTPUT,
    check = true,
    tmp = tmpdir(),
    input,
  } = options;
  const directory = await mkdtemp(join(tmp, 'dsh-git-'));
  const stdoutPath = join(directory, 'stdout');
  const stderrPath = join(directory, 'stderr');
  const stdinPath = join(directory, 'stdin');
  try {
    const stdoutFd = await open(stdoutPath, 'w');
    const stderrFd = await open(stderrPath, 'w');
    const handles = [stdoutFd, stderrFd];
    let stdin = 'ignore';
    let child;
    try {
      if (input !== undefined) {
        await writeFile(stdinPath, input);
        const stdinFd = await open(stdinPath, 'r');
        handles.push(stdinFd);
        stdin = stdinFd.fd;
      }
      child = spawn('git', args, {
        cwd,
        env,
        stdio: [stdin, stdoutFd.fd, stderrFd.fd],
        windowsHide: true,
      });
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.on('error', (error) => finish({ error }));
      child.on('close', (code) => finish({ code }));
      if (timeout > 0) {
        const timer = setTimeout(() => {
          child.kill();
          finish({ code: null, timedOut: timeout });
        }, timeout);
        timer.unref?.();
      }
    });
    const stdout = await readCapped(stdoutPath, maxOutput);
    const stderr = await readCapped(stderrPath, STDERR_LIMIT);
    if (outcome.error) throw new GitError({ args, code: null, stdout: stdout.text, stderr: stderr.text, cause: outcome.error });
    if (outcome.timedOut) {
      throw new GitError({ args, code: null, stdout: stdout.text, stderr: stderr.text, timeout: outcome.timedOut });
    }
    if (check && outcome.code !== 0) {
      throw new GitError({ args, code: outcome.code, stdout: stdout.text, stderr: stderr.text });
    }
    return { stdout: stdout.text, stderr: stderr.text, code: outcome.code, truncated: stdout.truncated };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readCapped(file, limit) {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return { text: '', truncated: false };
  }
  if (size <= limit) return { text: await readFile(file, 'utf8'), truncated: false };
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: true };
  } finally {
    await handle.close();
  }
}

export async function gitAvailable(cwd) {
  try {
    await git(['--version'], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
