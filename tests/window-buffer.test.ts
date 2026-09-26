import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSendBuffer, type BufferedMessage } from '../src/main/windows/send-buffer.ts';

type Role = 'operator' | 'output' | 'confidence';

const message = (channel: string, payload: unknown = {}): BufferedMessage => ({ channel, payload });

test('THE ORIGINAL BUG: a message sent before the renderer loads is kept, not lost', () => {
  /*
   * webContents.send to a window that has not finished loading is dropped silently. The phone's
   * one-shot `ready` message went that way, so no WebRTC offer was ever created and the phone sat
   * at "CAMERA READY" with Connection "—" forever.
   */
  const buffer = createSendBuffer<Role>();

  const buffered = buffer.enqueue('output', message('wireless:signal', { kind: 'ready' }));
  assert.equal(buffered, true, 'it must be buffered, not sent into the void');
  assert.equal(buffer.pendingCount('output'), 1);

  const flushed = buffer.markReady('output');
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.channel, 'wireless:signal');
  assert.deepEqual(flushed[0]?.payload, { kind: 'ready' });
});

test('once ready, messages pass straight through', () => {
  const buffer = createSendBuffer<Role>();
  buffer.markReady('output');
  assert.equal(buffer.enqueue('output', message('a')), false, 'not buffered — send it now');
  assert.equal(buffer.pendingCount('output'), 0);
});

test('buffered messages flush IN ORDER — a handshake depends on it', () => {
  // An answer applied before its offer, or ICE before either, breaks negotiation.
  const buffer = createSendBuffer<Role>();
  for (const kind of ['ready', 'answer', 'ice-1', 'ice-2']) {
    buffer.enqueue('output', message('wireless:signal', { kind }));
  }
  assert.deepEqual(
    buffer.markReady('output').map((entry) => (entry.payload as { kind: string }).kind),
    ['ready', 'answer', 'ice-1', 'ice-2'],
  );
});

test('roles are buffered independently', () => {
  const buffer = createSendBuffer<Role>();
  buffer.enqueue('output', message('for-output'));
  buffer.enqueue('operator', message('for-operator'));

  const outputMessages = buffer.markReady('output');
  assert.equal(outputMessages.length, 1);
  assert.equal(outputMessages[0]?.channel, 'for-output');
  assert.equal(buffer.pendingCount('operator'), 1, 'the operator queue is untouched');
});

test('the queue is bounded, dropping oldest first', () => {
  const dropped: string[] = [];
  const buffer = createSendBuffer<Role>({
    maxPending: 3,
    onDrop: (_role, entry) => dropped.push(entry.channel),
  });

  for (const channel of ['m1', 'm2', 'm3', 'm4', 'm5']) buffer.enqueue('output', message(channel));

  // Newest messages are the ones still worth delivering.
  assert.deepEqual(dropped, ['m1', 'm2']);
  assert.deepEqual(
    buffer.markReady('output').map((entry) => entry.channel),
    ['m3', 'm4', 'm5'],
  );
});

test('a dropped message is reported rather than vanishing silently', () => {
  // Silent loss is precisely what caused the original failure.
  const dropped: string[] = [];
  const buffer = createSendBuffer<Role>({ maxPending: 1, onDrop: (role) => dropped.push(role) });
  buffer.enqueue('output', message('first'));
  buffer.enqueue('output', message('second'));
  assert.deepEqual(dropped, ['output']);
});

test('A CLOSED WINDOW IS NO LONGER READY — otherwise the bug returns', () => {
  /*
   * If a role stayed marked ready after its window closed, the NEXT window opened under that role
   * would have its first messages sent before it was listening — reproducing the original fault
   * for the second phone of a service.
   */
  const buffer = createSendBuffer<Role>();
  buffer.markReady('output');
  assert.equal(buffer.isReady('output'), true);

  buffer.forget('output');
  assert.equal(buffer.isReady('output'), false);
  assert.equal(buffer.enqueue('output', message('after-reopen')), true, 'buffered again');
});

test('forgetting a role discards its queue', () => {
  const buffer = createSendBuffer<Role>();
  buffer.enqueue('output', message('stale'));
  buffer.forget('output');
  assert.equal(buffer.pendingCount('output'), 0);
  assert.deepEqual(buffer.markReady('output'), []);
});

test('markReady on an idle role flushes nothing and does not throw', () => {
  const buffer = createSendBuffer<Role>();
  assert.deepEqual(buffer.markReady('confidence'), []);
});

test('a dev-server reload re-flushes anything queued since', () => {
  // did-finish-load fires again after an HMR full reload, which is exactly when a replay is needed.
  const buffer = createSendBuffer<Role>();
  buffer.markReady('output');
  buffer.forget('output'); // the reload tears the page down
  buffer.enqueue('output', message('during-reload'));

  const flushed = buffer.markReady('output');
  assert.deepEqual(flushed.map((entry) => entry.channel), ['during-reload']);
});
