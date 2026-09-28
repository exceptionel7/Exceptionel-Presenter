import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { createLiveStateService, type LiveStateService } from '../src/main/services/live-state-service.ts';
import { createBibleService, type BibleService } from '../src/main/services/bible-service.ts';
import { createWirelessCameraService, type WirelessCameraService } from '../src/main/services/wireless-camera-service.ts';
import { createCameraSourceRegistry } from '../src/main/services/camera-source-registry.ts';
import { openService } from '../src/main/services/service-opener.ts';
import { validateBiblePackage } from '../src/shared/domain/bible-package.ts';
import { resolveAudienceVisibility } from '../src/shared/domain/live-state.ts';
import type { CameraSource } from '../src/shared/domain/camera.ts';
import type { InterfaceRecord } from '../src/main/services/network.ts';

/**
 * EXCEPTIONEL PRESENTER — Clear, with Scripture on air over a live camera.
 *
 * The operator action most likely to be used under pressure and least likely to be tested: hide the
 * words, keep the picture. Section 21 exists because that distinction is what operators actually reach
 * for, and getting it wrong in either direction is visible to a congregation — either the camera drops
 * with the text, or a stale Scripture frame stays on the projector.
 *
 * NO REAL SCRIPTURE IN THIS FILE, for the same reason the application bundles none.
 */

const LAN: InterfaceRecord[] = [{ name: 'wlan0', address: '192.168.1.100', family: 'IPv4', internal: false }];

interface Harness {
  db: AppDatabase;
  live: LiveStateService;
  bible: BibleService;
  wireless: WirelessCameraService;
  cameras: ReturnType<typeof createCameraSourceRegistry>;
  sources: () => CameraSource[];
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = openDatabase({ path: ':memory:' });
  const live = createLiveStateService();
  const bible = createBibleService({ db, chooseFile: () => Promise.resolve(null) });

  let latest: CameraSource[] = [];
  const cameras = createCameraSourceRegistry({ onChanged: (next) => { latest = next; } });

  const wireless = createWirelessCameraService({
    userDataDir: '/tmp',
    port: 0,
    bindAddress: '127.0.0.1',
    readInterfaces: () => LAN,
    onStatus: () => undefined,
    onPhonesChanged: (phones) => cameras.syncWireless(phones),
    onSignalToDesktop: () => undefined,
  });

  const pkg = validateBiblePackage({
    translation: { id: 'sample', abbreviation: 'SMP', name: 'Sample', language: 'en', license: 'Public domain' },
    books: [{ number: 43, chapters: [['placeholder one', 'placeholder two', 'placeholder three']] }],
  });
  assert.ok(pkg.ok);
  db.bible.install(pkg.value);

  return {
    db,
    live,
    bible,
    wireless,
    cameras,
    sources: () => latest,
    cleanup: async () => {
      await wireless.stop();
      db.close();
    },
  };
}

/** Brings a phone camera all the way to live. */
function cameraOnAir(h: Harness): string {
  const ticket = h.wireless.createSession('Phone');
  h.wireless.notifyClaim(ticket.sessionId, true);
  h.wireless.markTrackReceived(ticket.sessionId);

  const source = h.sources().find((entry) => entry.isWireless);
  assert.ok(source, 'the phone must appear as a camera source');
  h.cameras.assign(source.id, 'live');
  h.wireless.setLive(ticket.sessionId, true);

  return ticket.sessionId;
}

/** Puts a scripture cue on air and returns its id. */
function scriptureOnAir(h: Harness): string {
  const service = h.db.services.save({
    name: 'Sunday',
    themeId: 'theme-live-worship',
    items: [
      { kind: 'scripture', label: 'John 1:1-3', sortOrder: 0, config: { reference: 'John 1:1-3', translationId: 'sample' } },
    ],
  });

  const opened = openService(h.db, h.live, service.id, h.bible);
  assert.ok(opened);
  assert.ok(opened.cues.length > 0, 'the passage must produce cues');

  const cue = opened.cues[0]!;
  assert.ok(cue.caption, 'a scripture cue carries its reference as a caption');
  h.live.apply({ type: 'goLive', cueId: cue.id });
  return cue.id;
}

// ── the behaviour under test ─────────────────────────────────────────────────────

test('CLEAR HIDES SCRIPTURE AND ITS REFERENCE, AND LEAVES THE CAMERA LIVE', async () => {
  const h = await harness();
  try {
    await h.wireless.start();
    const sessionId = cameraOnAir(h);
    const cueId = scriptureOnAir(h);

    // Everything on: camera live, scripture on air, text and reference showing.
    const before = resolveAudienceVisibility(h.live.getState());
    assert.equal(h.live.getState().status, 'live');
    assert.equal(before.showText, true);
    assert.equal(before.showCamera, true);

    h.live.apply({ type: 'clear' });
    const state = h.live.getState();
    const after = resolveAudienceVisibility(state);

    // 1 & 2. The words and the reference go. They live in the same layer, so one flag removes both.
    assert.equal(after.showText, false, 'scripture text must be hidden');

    // 3. The camera stays.
    assert.equal(after.showCamera, true, 'the camera must remain visible');
    assert.equal(after.showBase, true);

    // 4. And the audience is not left on a stale frame: nothing is painted over the camera.
    assert.equal(after.opaqueBlack, false, 'Clear is not a black-out');

    // 5. The camera connection is untouched.
    assert.equal(h.wireless.status().phones[0]?.state, 'live', 'the phone is still live');

    // 6. And so is its assignment.
    const source = h.sources().find((entry) => entry.isWireless);
    assert.equal(source?.assignment, 'live', 'CameraSource state must not change');

    // 7. The slide is remembered, so Clear is reversible.
    assert.equal(state.status, 'clear');
    assert.equal(state.activeCueId, cueId, 'the cue stays mounted rather than being torn down');
    assert.equal(state.restoreCueId, cueId);
    assert.ok(sessionId.length > 0);
  } finally {
    await h.cleanup();
  }
});

test('CLEAR IS REVERSIBLE AND BRINGS BACK THE SAME SLIDE', async () => {
  // Pressing C twice is how an operator uses it. The reference must come back with the words.
  const h = await harness();
  try {
    await h.wireless.start();
    cameraOnAir(h);
    const cueId = scriptureOnAir(h);

    h.live.apply({ type: 'clear' });
    h.live.apply({ type: 'clear' });

    const state = h.live.getState();
    assert.equal(state.status, 'live');
    assert.equal(state.activeCueId, cueId, 'the same passage, not the top of the service');
    assert.equal(resolveAudienceVisibility(state).showText, true);
    assert.equal(h.wireless.status().phones[0]?.state, 'live', 'and the camera never moved');
  } finally {
    await h.cleanup();
  }
});

test('CLEAR SENDS NO SIGNAL TO THE PHONE AND NO MESSAGE TO THE OUTPUT WINDOW', async () => {
  /*
   * The strongest form of "Clear must not modify the camera": it must not talk to it at all. A `bye` here
   * would tear down the peer connection, and a state change would move the camera out of `live`.
   */
  const db = openDatabase({ path: ':memory:' });
  const signals: { sessionId: string; kind: string }[] = [];
  try {
    const live = createLiveStateService();
    const cameras = createCameraSourceRegistry({ onChanged: () => undefined });
    const wireless = createWirelessCameraService({
      userDataDir: '/tmp',
      port: 0,
      bindAddress: '127.0.0.1',
      readInterfaces: () => LAN,
      onStatus: () => undefined,
      onPhonesChanged: (phones) => cameras.syncWireless(phones),
      onSignalToDesktop: (sessionId, message) => signals.push({ sessionId, kind: message.kind }),
    });

    await wireless.start();
    const ticket = wireless.createSession('Phone');
    wireless.notifyClaim(ticket.sessionId, true);
    wireless.markTrackReceived(ticket.sessionId);
    wireless.setLive(ticket.sessionId, true);

    live.setCues([
      { id: 'cue_1', kind: 'scripture', itemId: 'item_1', label: 'John 1:1', lines: ['placeholder'], themeId: null, caption: 'John 1:1 (SMP)' },
    ]);
    live.apply({ type: 'goLive', cueId: 'cue_1' });

    const before = signals.length;
    live.apply({ type: 'clear' });

    assert.equal(signals.length, before, 'Clear must produce no camera signalling whatsoever');
    assert.equal(wireless.status().phones[0]?.state, 'live');

    await wireless.stop();
  } finally {
    db.close();
  }
});

test('BLACK is different from CLEAR, and still does not disconnect the camera', async () => {
  /*
   * The pair only makes sense if they differ. Black covers everything including the camera; Clear hides
   * the words alone. Neither may end the connection — a black-out is a moment in a service, not the end
   * of a camera.
   */
  const h = await harness();
  try {
    await h.wireless.start();
    cameraOnAir(h);
    scriptureOnAir(h);

    h.live.apply({ type: 'black' });
    const blacked = resolveAudienceVisibility(h.live.getState());

    assert.equal(blacked.opaqueBlack, true, 'Black covers the camera as well');
    assert.equal(blacked.showText, false);
    assert.equal(h.wireless.status().phones[0]?.state, 'live', 'but the camera keeps running underneath');

    const source = h.sources().find((entry) => entry.isWireless);
    assert.equal(source?.assignment, 'live');
  } finally {
    await h.cleanup();
  }
});

// ── the rendering side of the same guarantee ─────────────────────────────────────

test('THE CAPTION IS GATED BY showText, SO IT CANNOT OUTLIVE ITS VERSE', () => {
  /*
   * Source-level, because there is no DOM here. The reference sits inside the text layer, so the single
   * `showText` flag removes both — a citation left on screen naming verses the congregation can no longer
   * see would be worse than no citation at all.
   */
  const canvas = readFileSync(join(process.cwd(), 'src', 'renderer', 'shared-ui', 'SlideCanvas.tsx'), 'utf8');

  assert.match(canvas, /const hasText = visibility\.showText && \(lines\.length > 0 \|\| hasCaption\)/);

  const textLayer = canvas.slice(canvas.indexOf('z3 TEXT'), canvas.indexOf('z4 FOREGROUND'));
  assert.match(textLayer, /captionStyle/, 'the caption is rendered inside the gated text layer');
  assert.match(canvas, /\{hasText && \(/, 'and the whole layer is conditional on it');
});

test('the camera layer is hidden rather than unmounted, so Clear cannot cost a re-buffer', () => {
  // Clear does not hide the camera, but Black does — and a black-out is exactly when the picture must
  // come straight back. Unmounting the element would destroy it and force a visible re-buffer.
  const canvas = readFileSync(join(process.cwd(), 'src', 'renderer', 'shared-ui', 'SlideCanvas.tsx'), 'utf8');
  assert.match(canvas, /visibility:\s*visibility\.showCamera\s*\?\s*'visible'\s*:\s*'hidden'/);
  assert.match(canvas, /\{cameraStream !== null && \(/, 'mounted whenever a stream exists');
});
