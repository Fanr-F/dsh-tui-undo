import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLog, describeError } from '../src/log.mjs';

test('a disabled log is a no-op', async () => {
  const log = createLog();
  log.write('plugin', 'ignored');
  await log.flush();
  assert.equal(log.file, null);
  assert.equal(await log.tail(), '');
});

test('the log appends lines, flushes and reports its tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-undo-log-'));
  try {
    const file = join(root, 'nested', 'plugin.log');
    const log = createLog({ file });
    log.write('plugin', 'install', { root: 'C:/work' });
    log.write('undo', 'requested', { seq: 12 });
    await log.flush();
    const text = await readFile(file, 'utf8');
    assert.match(text, /plugin\s+install/);
    assert.match(text, /"seq":12/);
    const tail = await log.tail(1);
    assert.match(tail, /requested/);
    assert.doesNotMatch(tail, /install/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('logging never throws on an unwritable path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-undo-log-bad-'));
  try {
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'not a directory');
    const log = createLog({ file: join(blocker, 'plugin.log') });
    log.write('plugin', 'install');
    await log.flush();
    assert.equal(await log.tail(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('describeError keeps the message and the first frame', () => {
  const described = describeError(new Error('boom'));
  assert.equal(described.message, 'boom');
  assert.equal(typeof described.frame, 'string');
  assert.equal(describeError('plain'), 'plain');
});
