import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHONE_PAGE_CSS, PHONE_PAGE_HTML, PHONE_PAGE_JS } from '../src/main/services/phone-page.ts';
import { PAIRING_STATES } from '../src/shared/domain/pairing.ts';

test('THE SERVED SCRIPT CONTAINS NO BACKTICK — it lives in a String.raw template', () => {
  /*
   * Regression guard. A backtick inside the String.raw template terminates it, which broke the
   * module outright; and an escaped one would survive into the served JavaScript as a literal
   * backslash-backtick, producing a syntax error on the phone instead. Neither failure is
   * detectable by reading the file, so it is asserted.
   */
  assert.doesNotMatch(PHONE_PAGE_JS, /`/, 'no backtick may appear in the phone script');
  assert.doesNotMatch(PHONE_PAGE_JS, /\$\{/, 'no template interpolation either');
});

test('the served page and stylesheet are also free of template metacharacters', () => {
  assert.doesNotMatch(PHONE_PAGE_HTML, /`/);
  assert.doesNotMatch(PHONE_PAGE_CSS, /`/);
});

test('the script is syntactically valid JavaScript', () => {
  // Parsed rather than eyeballed: a syntax error here means a blank page on the phone with the
  // cause buried in a mobile browser console nobody can read.
  assert.doesNotThrow(() => new Function(PHONE_PAGE_JS), 'the phone script must parse');
});

test('A DEAD LINK AND A WRONG PIN GIVE DIFFERENT ADVICE', () => {
  // Telling someone to check the PIN when their code has expired sends them round in circles,
  // because no PIN will ever work.
  assert.match(PHONE_PAGE_JS, /invalid-link/, 'the collapsed dead-link reason is handled');
  assert.match(PHONE_PAGE_JS, /Scan the CURRENT QR code/);
  assert.match(PHONE_PAGE_JS, /restarting the application creates new ones/);
  assert.match(PHONE_PAGE_JS, /The PIN is on the computer, not in the QR code/);
});

test('a dead link hides the PIN field, since typing cannot help', () => {
  assert.match(PHONE_PAGE_JS, /el\('pin'\)\.hidden = true/);
});

test('every terminal claim failure the server can report is branched on', () => {
  for (const reason of ['expired', 'revoked', 'already-claimed', 'too-many-attempts']) {
    assert.match(PHONE_PAGE_JS, new RegExp(reason), `${reason} must be handled explicitly`);
  }
  // 'not-found' and 'bad-token' are deliberately collapsed server-side into 'invalid-link', so the
  // phone must NOT branch on them — doing so would mean the server was leaking which ids exist.
  assert.doesNotMatch(PHONE_PAGE_JS, /'not-found'/);
  assert.doesNotMatch(PHONE_PAGE_JS, /'bad-token'/);
});

test('the pairing states the server can be in are all real states', () => {
  // Guards against the phone or server drifting onto a state the domain does not define.
  for (const state of PAIRING_STATES) {
    assert.ok(typeof state === 'string' && state.length > 0);
  }
});

test('the page uses the real camera and WebRTC APIs, not a simulation', () => {
  assert.match(PHONE_PAGE_JS, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(PHONE_PAGE_JS, /new RTCPeerConnection/);
  assert.match(PHONE_PAGE_JS, /iceServers: \[\]/, 'LAN only — no STUN or TURN');
  assert.doesNotMatch(PHONE_PAGE_JS, /canvas|createImageData|fillRect/, 'no synthesised frames');
});

test('rear camera is the default, and switching stops the old track first', () => {
  assert.match(PHONE_PAGE_JS, /facing = 'environment'/);
  // iOS will not open the second camera while the first is still held.
  assert.match(PHONE_PAGE_JS, /if \(old\) old\.stop\(\);/);
  assert.match(PHONE_PAGE_JS, /replaceTrack/, 'switching must not renegotiate');
});

test('stopping releases every track so the OS camera indicator goes out', () => {
  assert.match(PHONE_PAGE_JS, /stream\.getTracks\(\)\.forEach\(function \(track\) \{ track\.stop\(\); \}\)/);
  assert.match(PHONE_PAGE_JS, /pagehide/, 'locking the phone or closing the tab must release it too');
});

test('the page declares its own live indicator states', () => {
  assert.match(PHONE_PAGE_HTML, /CAMERA OFF/);
  assert.match(PHONE_PAGE_JS, /CAMERA LIVE/);
  assert.match(PHONE_PAGE_JS, /CAMERA READY/);
});

test('the HTML is touch-first and iOS-safe', () => {
  assert.match(PHONE_PAGE_HTML, /playsinline/, 'or iOS takes the video fullscreen');
  assert.match(PHONE_PAGE_HTML, /muted/, 'required for autoplay');
  assert.match(PHONE_PAGE_HTML, /viewport-fit=cover/);
  assert.match(PHONE_PAGE_HTML, /inputmode="numeric"/, 'a numeric keypad for the PIN');
  assert.match(PHONE_PAGE_CSS, /env\(safe-area-inset-top\)/, 'respects the notch');
});

test('the page never references an external origin', () => {
  // It must work on a church network with no internet at all.
  const external = /https?:\/\/(?!localhost)[a-z0-9.-]+/gi;
  for (const [name, source] of [
    ['html', PHONE_PAGE_HTML],
    ['js', PHONE_PAGE_JS],
    ['css', PHONE_PAGE_CSS],
  ] as const) {
    const matches = source.match(external) ?? [];
    assert.deepEqual(matches, [], `${name} must not fetch anything from the internet`);
  }
});


test('EARLY ICE CANDIDATES ARE QUEUED, NOT DISCARDED', () => {
  /*
   * The desktop begins trickling candidates the instant it sets its own local description — before
   * this page has even received the offer. `addIceCandidate` rejects while there is no remote
   * description, so the original code threw those candidates away. On a LAN with no STUN or TURN
   * they are the only candidates there are, which left ICE with nothing to pair and produced a
   * connection that negotiated successfully and then carried no video.
   */
  assert.match(PHONE_PAGE_JS, /var pendingIce = \[\]/, 'a queue exists');
  assert.match(PHONE_PAGE_JS, /if \(!pc\.remoteDescription\) \{\s*pendingIce\.push\(candidate\)/);
  assert.match(PHONE_PAGE_JS, /drainPendingIce/, 'and is drained once the offer is applied');
  // Drained after the answer is posted, so the desktop has the answer before the candidates.
  assert.match(PHONE_PAGE_JS, /post\(\{ kind: 'answer', sdp: answer\.sdp \}\);[\s\S]{0,120}drainPendingIce\(\)/);
});

test('the phone shows the ICE state, so a photograph of the page is diagnosable', () => {
  // "checking" that never becomes "connected" means the devices cannot reach each other — usually
  // client isolation on the access point. That is invisible without showing the ICE state.
  assert.match(PHONE_PAGE_JS, /oniceconnectionstatechange/);
  assert.match(PHONE_PAGE_JS, /pc\.connectionState \+ ' · ' \+ pc\.iceConnectionState/);
});


// ── stopping the camera versus ending the session ────────────────────────────────

test('STOPPING THE CAMERA SENDS STANDBY, NOT BYE', () => {
  /*
   * Reported from a real session: stop the phone, start it again, and nothing connects.
   *
   * The STOP button used to post `bye`, which revoked the phone's credentials — so pressing START
   * again posted to a dead session. Stopping a camera is not ending a session.
   */
  assert.match(PHONE_PAGE_JS, /kind: 'standby', reason: reason \|\| 'Camera stopped on phone'/);
  assert.equal(
    /kind: 'bye'/.test(PHONE_PAGE_JS),
    false,
    'the phone never ends its own session — the operator does that with Disconnect',
  );
});

test('EVERY UPSTREAM MESSAGE CHECKS ITS RESPONSE STATUS', () => {
  /*
   * The second half of the same bug. `post()` ignored the HTTP status entirely, so a 401 from a revoked
   * session was swallowed and the phone showed CAMERA READY with nothing wrong on screen. A silent
   * failure is worse than a loud one.
   */
  assert.match(PHONE_PAGE_JS, /if \(response\.status === 401\) \{ sessionEnded\(\); \}/);
  assert.match(PHONE_PAGE_JS, /function sessionEnded/);
});

test('a genuinely ended session says so and stops inviting retries', () => {
  assert.match(PHONE_PAGE_JS, /SESSION ENDED/);
  assert.match(PHONE_PAGE_JS, /This camera session has ended/);
  assert.match(PHONE_PAGE_JS, /Scan the CURRENT QR code/);
  // START must not be re-enabled over that message, or the operator will press it against a 401.
  assert.match(PHONE_PAGE_JS, /if \(ended\) return;/);
});

test('a network drop is not mistaken for an ended session', () => {
  // Out of range is recoverable; revoked is not. Claiming the wrong one sends the operator to the wrong
  // remedy — hunting for a QR code when they only needed to walk back into Wi-Fi range.
  assert.match(PHONE_PAGE_JS, /out of range, not ended/);
  assert.match(PHONE_PAGE_JS, /readyState === 2/, 'only a browser that has given up is conclusive');
});

test('losing the page does not end the session', () => {
  // Locking a phone or backgrounding the tab must not require re-pairing.
  const pagehide = PHONE_PAGE_JS.slice(PHONE_PAGE_JS.indexOf("addEventListener('pagehide'"));
  assert.equal(/kind: 'bye'/.test(pagehide), false);
  assert.equal(/kind: 'standby'/.test(pagehide), false);
});
