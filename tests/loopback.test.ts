import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EXCEPTIONEL PRESENTER — invariants of the loopback camera path.
 *
 * WHAT THESE ARE. Source-text assertions. `loopback.ts` is built on `RTCPeerConnection`, which does not
 * exist in Node, so the real negotiation cannot be exercised here and these are weaker than a browser
 * test would be.
 *
 * WHY THEY ARE WORTH HAVING ANYWAY. The bug they pin was invisible and was reported from a real service:
 * the camera showed in one operator section and not another, while the audience output displayed it
 * perfectly well the whole time. Nothing threw, nothing logged, and the failure depended on which screen
 * happened to be open when the phone's track arrived.
 */

const SRC = join(process.cwd(), 'src', 'renderer');
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const LOOPBACK = read('shared-ui', 'loopback.ts');
const SERVICE = read('operator', 'sections', 'Service.tsx');
const CAMERA = read('operator', 'sections', 'Camera.tsx');

// ── the one-shot offer ───────────────────────────────────────────────────────────

test('A SUBSCRIBER CAN ASK FOR STREAMS THAT WERE PUBLISHED BEFORE IT EXISTED', () => {
  /*
   * The cause of the reported bug. A loopback offer was sent exactly once, at the moment the phone's
   * track arrived — so whichever section was mounted then got the picture, and any section opened
   * afterwards got nothing at all.
   */
  assert.match(LOOPBACK, /loopback: 'request'/, 'the request message exists');
  assert.match(LOOPBACK, /requestStreams\(\): void/, 'and the subscriber exposes it');
  assert.match(
    LOOPBACK,
    /if \(message\.loopback === 'request'\) \{\s*for \(const \[id, stream\] of published\) offer\(id, stream\);/,
    'and the publisher serves it from its retained streams',
  );
});

test('the publisher RETAINS streams, because a closed connection cannot give its tracks back', () => {
  assert.match(LOOPBACK, /const published = new Map<string, MediaStream>\(\)/);
  assert.match(LOOPBACK, /published\.set\(id, stream\)/, 'publish records it');
  assert.match(LOOPBACK, /published\.delete\(id\)/, 'unpublish forgets it');
  assert.match(LOOPBACK, /published\.clear\(\)/, 'and closeAll clears them');
});

test('a request is handled BEFORE the id lookup, since it carries no id', () => {
  // Placed after the `connections.get(message.id)` guard it would always early-return and silently do
  // nothing — the same class of invisible failure it exists to fix.
  const handleRelay = LOOPBACK.slice(LOOPBACK.indexOf('handleRelay(message) {'));
  const requestAt = handleRelay.indexOf("message.loopback === 'request'");
  const lookupAt = handleRelay.indexOf('connections.get(message.id)');
  assert.ok(requestAt > 0 && lookupAt > 0);
  assert.ok(requestAt < lookupAt, 'the request branch must come first');
});

test('EVERY OPERATOR SECTION THAT PREVIEWS A CAMERA ASKS ON MOUNT', () => {
  // Waiting passively is what produced a blank preview for a camera that was plainly on air.
  for (const [name, source] of [
    ['Service.tsx', SERVICE],
    ['Camera.tsx', CAMERA],
  ] as const) {
    assert.match(source, /subscriber\.requestStreams\(\)/, `${name} must request a republish on mount`);
  }
});

test('a second answer to one offer cannot become an unhandled rejection', () => {
  // Two operator sections mounted at once would each answer. The first wins; the second must be
  // swallowed rather than crashing the renderer that owns every phone connection.
  const start = LOOPBACK.indexOf("message.loopback === 'answer'");
  assert.ok(start > 0, 'the answer branch exists');
  // Bounded by the end of the statement rather than a character count, so a comment cannot push the
  // thing being asserted outside the window.
  const answerBranch = LOOPBACK.slice(start, LOOPBACK.indexOf('return;', start));
  assert.match(answerBranch, /\.catch\(\(\) => undefined\)/);
});

// ── the live pane must not lie ───────────────────────────────────────────────────

test('THE OPERATOR PANES SHOW ONLY THE CAMERA THAT IS ACTUALLY ON AIR', () => {
  /*
   * The subscriber receives EVERY paired camera. Painting whichever arrived first would put a camera in
   * the LIVE pane that the congregation is not seeing — the preview lying about the one thing it exists
   * to be trusted on.
   */
  assert.match(SERVICE, /assignment === 'live' && source\.isWireless/, 'the live source is identified');
  assert.match(
    SERVICE,
    /liveCameraId === null \? null : \(cameraStreams\.get\(liveCameraId\) \?\? null\)/,
    'and only its stream is used',
  );
});

test('the live camera assignment is fetched as well as listened for', () => {
  // It may have been set before this section was opened, in which case no event is coming.
  assert.match(SERVICE, /client\.invoke\('camera:sources'\)/);
  assert.match(SERVICE, /useIpcEvent\('camera:sources'/);
});

test('the source id scheme is shared between the registry and the renderers', () => {
  // The loopback id and the camera source id must be the same string, or the lookup above finds nothing.
  const sourceId = read('output', 'source-id.ts');
  assert.match(sourceId, /export const WIRELESS_SOURCE_PREFIX = 'phone:'/);
  assert.match(sourceId, /sourceIdForSession = \(sessionId: string\): string => `\$\{WIRELESS_SOURCE_PREFIX\}\$\{sessionId\}`/);
});
