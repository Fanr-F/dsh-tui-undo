import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostError, canDrive, createSurfacePort, describeHost } from '../src/host.mjs';
import { surfaceNodes } from '../src/surface.mjs';
import { FakeSession, user } from './fake-session.mjs';

function seeded() {
  const session = new FakeSession();
  session.append('user/message', user('m1', 'one'), { surfaceOp: 'append' });
  session.append('user/message', user('m2', 'two'), { surfaceOp: 'append' });
  return session;
}

test('a live surface session is drivable; the port exposes log, surface and ops', () => {
  const session = seeded();
  assert.equal(canDrive(session), true);
  assert.deepEqual(describeHost(session), { canDrive: true, missing: [] });

  const port = createSurfacePort({ session });
  assert.equal(port.id, 'session-1');
  assert.equal(port.header().cwd, 'D:/work');
  assert.deepEqual(port.events().map((event) => event.seq), [0, 1]);
  assert.deepEqual(port.visible(), [0, 1]);
});

test('events() and visible() return detached values', () => {
  const session = seeded();
  const port = createSurfacePort({ session });
  const events = port.events();
  events[0].data.id = 'mutated';
  events.push({ seq: 99, type: 'user/message' });
  const nodes = port.visible();
  nodes.push(99);

  assert.equal(session.snapshotEvents()[0].data.id, 'm1');
  assert.equal(session.snapshotEvents().length, 2);
  assert.deepEqual(surfaceNodes(session), [0, 1]);
});

test('the port hides a tail and replays a copy through the surface', () => {
  const session = seeded();
  const port = createSurfacePort({ session });

  const hidden = port.hideFrom(1);
  assert.deepEqual(hidden, [1]);
  assert.deepEqual(port.visible(), [0, 2]);

  const copy = port.showCopies([session.snapshotEvents()[1]]);
  assert.equal(copy.length, 1);
  assert.deepEqual(port.visible(), [0, 2, 3]);
});

test('an incapable host refuses to build a port and names what is missing', () => {
  assert.throws(() => createSurfacePort({ session: { id: 's' } }), HostError);
  assert.throws(() => createSurfacePort({ session: { id: 's' } }), /append, snapshotEvents, surface/);
  assert.equal(canDrive({ id: 's', append() {}, snapshotEvents() {} }), false);
  assert.deepEqual(describeHost({ append() {}, snapshotEvents() {} }).missing, ['surface']);
});
