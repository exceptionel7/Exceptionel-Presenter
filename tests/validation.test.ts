import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOrThrow,
  vArray,
  vDateOnly,
  vId,
  vInt,
  vObject,
  vOptional,
  vString,
  ValidationError,
} from '../src/shared/validation/validate.ts';
import { IPC_VALIDATORS, validatorFor } from '../src/shared/validation/ipc-validators.ts';
import { IPC_CHANNELS, OUTPUT_ALLOWED_CHANNELS } from '../src/shared/ipc-contract.ts';
import { SQL as SEED_SQL } from '../src/main/db/migrations/0002-seed.ts';

test('every declared IPC channel has a validator — fail-closed', () => {
  const missing = IPC_CHANNELS.filter((c) => !validatorFor(c));
  assert.deepEqual(missing, [], 'a channel without a validator must not exist');
  assert.equal(Object.keys(IPC_VALIDATORS).length, IPC_CHANNELS.length);
});

test('unknown channels resolve to no validator, so they cannot be dispatched', () => {
  assert.equal(validatorFor('songs:dropTable'), null);
  assert.equal(validatorFor('__proto__'), null, 'prototype keys must not leak a validator');
  assert.equal(validatorFor('toString'), null);
});

test('the audience output window is restricted to read-only channels', () => {
  for (const channel of OUTPUT_ALLOWED_CHANNELS) {
    assert.ok(IPC_CHANNELS.includes(channel), `${channel} must be a real channel`);
    assert.doesNotMatch(
      channel,
      /save|delete|set|import|assign|intent|restore|discard|quit|open|close/,
      `${channel} mutates state and must not be reachable from the audience screen`,
    );
  }
});

test('unknown keys are dropped, not merged — no field smuggling', () => {
  const v = vObject({ id: vId(), title: vString({ min: 1 }) });
  const r = v.parse({ id: 'abc', title: 'Way Maker', absPath: '/etc/passwd', isAdmin: true });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.ok ? r.value : {}), ['id', 'title']);
});

test('prototype pollution via a JSON config object is rejected', () => {
  const v = validatorFor('services:save')!;
  const r = v.parse({
    name: 'Sunday',
    items: [{ kind: 'song', label: 'Opening', sortOrder: 0, config: JSON.parse('{"__proto__":{"x":1}}') }],
  });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /forbidden key/);
});

test('ids reject path traversal and SQL-ish payloads', () => {
  for (const bad of ['../../etc/passwd', "a'; DROP TABLE songs;--", 'a b', '', 'x'.repeat(65)]) {
    assert.equal(vId().parse(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(vId().parse('song_01-ABC').ok, true);
});

test('error paths point at the exact offending field', () => {
  const v = vObject({ sections: vArray(vObject({ lyrics: vString({ min: 1 }) })) });
  const r = v.parse({ sections: [{ lyrics: 'ok' }, { lyrics: '' }] });
  assert.equal(r.ok, false);
  assert.equal((r as { path: string }).path, 'sections.1.lyrics');
});

test('impossible calendar dates are rejected', () => {
  assert.equal(vDateOnly().parse('2026-02-31').ok, false);
  assert.equal(vDateOnly().parse('2026-13-01').ok, false);
  assert.equal(vDateOnly().parse('2026-09-24').ok, true);
  assert.equal(vDateOnly().parse('24/09/2026').ok, false);
});

test('numeric bounds hold, and NaN/Infinity are not integers', () => {
  assert.equal(vInt({ min: 0, max: 10 }).parse(11).ok, false);
  assert.equal(vInt().parse(1.5).ok, false);
  assert.equal(vInt().parse(NaN).ok, false);
  assert.equal(vInt().parse(Infinity).ok, false);
  assert.equal(vInt().parse('3').ok, false, 'string digits must not coerce');
});

test('void channels reject stray payloads so typos surface', () => {
  const v = validatorFor('media:import')!;
  assert.equal(v.parse(undefined).ok, true);
  assert.equal(v.parse({ path: '/etc/shadow' }).ok, false);
});

test('media:import accepts no path — only a main-process dialog can choose files', () => {
  const r = validatorFor('media:import')!.parse({ absPath: '/Users/me/.ssh/id_rsa' });
  assert.equal(r.ok, false);
});

test('live:intent accepts valid intents and rejects unknown tags', () => {
  const v = validatorFor('live:intent')!;
  assert.equal(v.parse({ type: 'next' }).ok, true);
  assert.equal(v.parse({ type: 'goLive', cueId: 'cue_1' }).ok, true);
  assert.equal(v.parse({ type: 'goLive' }).ok, false, 'missing cueId');
  assert.equal(v.parse({ type: 'selfDestruct' }).ok, false);
  assert.equal(v.parse({ type: 'goToIndex', index: -1 }).ok, false);
});

test('song lyrics keep their blank lines — they are slide breaks', () => {
  const r = validatorFor('songs:save')!.parse({
    title: 'Way Maker',
    sections: [
      { kind: 'verse', label: 'Verse 1', sortOrder: 0, lyrics: 'You are here\n\nMoving in our midst', slideBreakMode: 'blank-line' },
    ],
  });
  assert.equal(r.ok, true);
  const section = (r as { value: { sections: { lyrics: string }[] } }).value.sections[0]!;
  assert.equal(section.lyrics, 'You are here\n\nMoving in our midst');
});

test('settings keys are dotted camelCase — blocks path-like keys reaching the store', () => {
  const v = validatorFor('settings:set')!;
  assert.equal(v.parse({ key: 'display.presentation-id', value: 3 }).ok, true);
  assert.equal(v.parse({ key: 'presentation.aspectRatio', value: '16:9' }).ok, true);
  assert.equal(v.parse({ key: 'Display.Bad', value: 1 }).ok, false, 'must not start uppercase');
  assert.equal(v.parse({ key: '../etc', value: 1 }).ok, false);
  assert.equal(v.parse({ key: 'a/b', value: 1 }).ok, false);
  assert.equal(v.parse({ key: 'has space', value: 1 }).ok, false);
  assert.equal(v.parse({ key: 'trailing.', value: 1 }).ok, false);
});

test('EVERY key seeded by migration 0002 passes the settings validator', () => {
  // Regression guard. The seeded keys are camelCase (presentation.aspectRatio); an
  // earlier lowercase-only pattern silently made all of them unwritable through IPC,
  // which no other test caught because reads bypass the validator.
  const v = validatorFor('settings:set')!;

  // Scope to the settings INSERT: the themes and shortcuts blocks also start rows with a
  // quoted identifier, and shortcut actions are dotted too ('live.previous').
  const blockStart = SEED_SQL.indexOf('INSERT INTO settings');
  assert.notEqual(blockStart, -1, 'migration 0002 must seed settings');
  const block = SEED_SQL.slice(blockStart);
  const seeded = [...block.matchAll(/^\('([A-Za-z][\w.-]*)',/gm)].map((m) => m[1]!);

  assert.ok(seeded.length >= 14, `expected to find the seeded keys, found ${seeded.length}`);
  assert.ok(seeded.includes('presentation.aspectRatio'), 'sanity-check the extraction');
  for (const key of seeded) {
    assert.equal(v.parse({ key, value: 1 }).ok, true, `seeded key "${key}" must be writable through IPC`);
  }
});

test('camera resolution must look like WxH, framerate must be sane', () => {
  const v = validatorFor('camera:saveProfile')!;
  const base = { label: 'Pastor Camera', provider: 'usb', deviceId: 'abc123' };
  assert.equal(v.parse({ ...base, resolution: '1920x1080', framerate: 30 }).ok, true);
  assert.equal(v.parse({ ...base, resolution: '1920*1080' }).ok, false);
  assert.equal(v.parse({ ...base, framerate: 0 }).ok, false);
  assert.equal(v.parse({ ...base, provider: 'telepathy' }).ok, false);
});

test('CCLI number must be digits only', () => {
  const ok = validatorFor('songs:save')!.parse({ title: 'T', ccliNumber: '7115744', sections: [] });
  assert.equal(ok.ok, true);
  const bad = validatorFor('songs:save')!.parse({ title: 'T', ccliNumber: 'CCLI-123', sections: [] });
  assert.equal(bad.ok, false);
});

test('parseOrThrow raises ValidationError carrying the field path', () => {
  assert.throws(
    () => parseOrThrow(vObject({ name: vString({ min: 1 }) }), { name: '' }),
    (e: unknown) => e instanceof ValidationError && e.path === 'name',
  );
});

test('optional vs null are distinguished', () => {
  const v = vObject({ note: vOptional(vString()) });
  assert.equal(v.parse({}).ok, true);
  assert.equal(v.parse({ note: null }).ok, false, 'null is not the same as absent');
});
