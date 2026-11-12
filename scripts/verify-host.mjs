/**
 * Real-host verification for the assumptions the PRD rests on (R1 / T15).
 *
 * It loads the `@deepseek-ai/dsh-session` that the installed dsh actually uses
 * and answers, with evidence, how a log can be shortened:
 *
 *   Q1  Does `Session.create(id, seed, ...)` truncate a live session?
 *   Q2  Does a `surfaceOp: replace` event hide covered rows from the surface?
 *   Q3  Are sequence numbers reused after rows are hidden?
 *   Q4  Can a hidden range be brought back with another surface op?
 *   Q5  Does `fromRestore` accept a prefix seed?
 *   Q6  Can a hidden message be shown again by appending a copy of it?
 *
 * Run: node scripts/verify-host.mjs
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { hideFrom, showCopies, surfaceNodes } from '../src/surface.mjs';

const candidates = [
  process.env.DSH_SESSION_DIR,
  join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session'),
  join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh-session'),
].filter(Boolean);

const directory = candidates.find((candidate) => existsSync(join(candidate, 'lib', 'index.js')));
if (!directory) {
  console.error('could not find @deepseek-ai/dsh-session; set DSH_SESSION_DIR');
  process.exit(2);
}
console.log(`using ${directory}\n`);

const { Session } = await import(pathToFileURL(join(directory, 'lib', 'index.js')).href);
const header = { version: 4, id: 'verify', createdAt: Date.now(), isSeeded: false, cwd: process.cwd() };
const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}\n      ${detail.replace(/\n/g, '\n      ')}`);
};

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const assistant = (id, text) => ({ id, role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text }] });
const developer = (id) => ({ id, role: 'developer', source: { kind: 'dsh-tui-undo' }, content: [] });

const live = Session.create('verify', [], header, 0, []);
live.append('user/message', user('m1', 'first'), { surfaceOp: 'append' });
live.append('assistant/message', { message: assistant('a1', 'answer'), stream: [] }, { surfaceOp: 'append' });
live.append('user/message', user('m2', 'second'), { surfaceOp: 'append' });
const total = live.snapshotEvents().length;
const surface = [...live.surface.nodes];

// Q1: create() with a truncated seed does not touch the live session. A seed
// also gains a `session/end-seed` marker, so it is never one-for-one.
const replacement = Session.create('verify', structuredClone(live.snapshotEvents().slice(0, 2)), header, 0, []);
record(
  'Q1-create-does-not-truncate-live',
  live.snapshotEvents().length === total && replacement.snapshotEvents().length === 3,
  `live kept ${live.snapshotEvents().length}/${total} events; the detached replacement holds ${replacement.snapshotEvents().length} (2 seed + 1 end-seed marker)`,
);

// Q2: a replace op shadows the covered surface nodes.
live.append('developer/message', { turn: 1, step: 1, message: developer('hide-1') }, {
  surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
  sourceEventSeqs: [2, 3],
});
const hidden = [...live.surface.nodes];
record(
  'Q2-replace-hides-surface-rows',
  !hidden.includes(2) && !hidden.includes(3) && hidden.includes(1),
  `surface before ${JSON.stringify(surface)} -> after ${JSON.stringify(hidden)}`,
);

// Q3: sequence numbers are never reused.
const nextSeq = live.seq;
live.append('user/message', user('m3', 'third'), { surfaceOp: 'append' });
const appended = live.snapshotEvents().at(-1).seq;
record('Q3-seq-never-reused', appended === nextSeq, `next seq after hiding was ${nextSeq}; appended at ${appended}`);

// Q4: a hidden range cannot be re-added to the surface.
let unhide;
try {
  live.append('developer/message', { turn: 1, step: 1, message: developer('show-1') }, {
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
    sourceEventSeqs: [2],
  });
  unhide = `accepted; surface now ${JSON.stringify([...live.surface.nodes])}`;
} catch (error) {
  unhide = `rejected: ${error.message}`;
}
record('Q4-resurface-needs-new-events', /not found in surface/.test(unhide), unhide);

// Q5: fromRestore accepts a prefix seed.
let restore;
try {
  const restored = Session.fromRestore('verify', structuredClone(live.snapshotEvents().slice(0, 2)), header, 0, 'shared-frozen', []);
  restore = `${restored.snapshotEvents().length} events, surface ${JSON.stringify([...restored.surface.nodes])}`;
} catch (error) {
  restore = `error: ${error.message}`;
}
record('Q5-fromRestore-prefix', /^3 events/.test(restore), restore);

// Q6: re-appending a clone of a hidden message makes it visible again.
let replay;
try {
  live.append('user/message', user('m1-copy', 'first'), { surfaceOp: 'append' });
  const seq = live.snapshotEvents().at(-1).seq;
  replay = `appended at ${seq}; surface ${JSON.stringify([...live.surface.nodes])}`;
} catch (error) {
  replay = `error: ${error.message}`;
}
record('Q6-append-copy-resurfaces', /appended at/.test(replay), replay);

// Q7: a copy may keep the original message id (decides how much M8 must rewrite).
let sameId;
try {
  const logged = live.append('user/message', user('m1', 'first'), { surfaceOp: 'append' });
  sameId = `accepted at seq ${logged.seq}`;
} catch (error) {
  sameId = `rejected: ${error.message}`;
}
record('Q7-copy-keeps-message-id', /accepted/.test(sameId), sameId);

// Q8: the plugin's own hide + batch redo are accepted by the real host.
// This is the end-to-end contract src/surface.mjs depends on: an empty
// developer/message carries the replace, and two copies land atomically.
let roundTrip;
try {
  const pluginHost = Session.create('verify-plugin', [], { ...header, id: 'verify-plugin' }, 0, []);
  pluginHost.append('turn/start', { turn: 1 });
  pluginHost.append('step/start', { turn: 1, step: 1 });
  pluginHost.append('user/message', user('u1', 'hello'), { surfaceOp: 'append' });
  pluginHost.append(
    'assistant/message',
    { turn: 1, step: 1, message: assistant('a1', 'hi'), stream: [] },
    { surfaceOp: 'append' },
  );

  const logged = pluginHost.snapshotEvents();
  const boundary = logged.find((event) => event.type === 'user/message').seq;
  const hidden = hideFrom(pluginHost, { startSeq: boundary });
  const afterHide = surfaceNodes(pluginHost);
  const copies = showCopies(
    pluginHost,
    logged.filter((event) => event.type === 'user/message' || event.type === 'assistant/message'),
  );
  const afterRedo = surfaceNodes(pluginHost);
  roundTrip = { hidden, afterHide, copies: copies.map((event) => event.seq), afterRedo };
  record(
    'Q8-plugin-hide-and-redo',
    hidden?.length === 2 && afterHide.length === 1 && copies.length === 2 && afterRedo.length === 3,
    `hide ${JSON.stringify(hidden)} -> surface ${JSON.stringify(afterHide)}; copies at ${JSON.stringify(roundTrip.copies)} -> ${JSON.stringify(afterRedo)}`,
  );
} catch (error) {
  record('Q8-plugin-hide-and-redo', false, `error: ${error.message}`);
}

// Q9: replayed copies carry fresh message and tool-call ids while staying paired.
let replayResult;
try {
  const h = Session.create('verify-replay', [], { ...header, id: 'verify-replay' }, 0, []);
  h.append('turn/start', { turn: 1 });
  h.append('step/start', { turn: 1, step: 1 });
  h.append('user/message', user('u1', 'use a tool'), { surfaceOp: 'append' });
  h.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
      },
      stream: [{ type: 'tool-call-chunks', time0: 0, index: 0, dt: [0], id: 'call-1', name: 'read', args: ['{}'] }],
    },
    { surfaceOp: 'append' },
  );
  h.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'r1',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: 'ok' }],
        toolCallId: 'call-1',
      },
    },
    { surfaceOp: 'append' },
  );

  const originals = h
    .snapshotEvents()
    .filter((event) => ['user/message', 'assistant/message', 'tool/result'].includes(event.type));
  hideFrom(h, { startSeq: originals[0].seq });
  const copies = showCopies(h, originals, { rewrite: true });
  const userCopy = copies.find((event) => event.type === 'user/message');
  const assistantCopy = copies.find((event) => event.type === 'assistant/message');
  const resultCopy = copies.find((event) => event.type === 'tool/result');
  const callId = assistantCopy.data.message.content[0].id;
  const ok =
    copies.length === 3 &&
    userCopy.data.id !== 'u1' &&
    assistantCopy.data.message.id !== 'a1' &&
    resultCopy.data.message.id !== 'r1' &&
    new Set([userCopy.data.id, assistantCopy.data.message.id, resultCopy.data.message.id]).size === 3 &&
    callId !== 'call-1' &&
    assistantCopy.data.stream[0].id === callId &&
    resultCopy.data.message.toolCallId === callId &&
    resultCopy.data.message.source.callId === callId;
  replay = { callId, ids: copies.map((event) => event.data.message?.id ?? event.data.id) };
  record(
    'Q9-replay-rewrites-ids',
    ok,
    `copies ${JSON.stringify(replay.ids)}; tool call ${callId} paired with result`,
  );
} catch (error) {
  record('Q9-replay-rewrites-ids', false, `error: ${error.message}`);
}

console.log('\nsummary');
for (const line of results) console.log(`  ${line.ok ? 'PASS' : 'FAIL'} ${line.id}`);
process.exit(results.every((line) => line.ok) ? 0 : 1);

