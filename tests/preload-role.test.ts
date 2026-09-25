import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_ROLE,
  ROLE_ARG_PREFIX,
  WINDOW_ROLES,
  parsePreloadRole,
  roleArgument,
} from '../src/shared/preload-role.ts';
import {
  CONFIDENCE_ALLOWED_CHANNELS,
  IPC_CHANNELS,
  OUTPUT_ALLOWED_CHANNELS,
} from '../src/shared/ipc-contract.ts';

/** A realistic Electron argv, where the role sits among Chromium's own switches. */
const argv = (...extra: string[]): string[] => [
  'C:\\app\\Exceptionel Presenter.exe',
  '--no-sandbox=false',
  '--lang=en-GB',
  ...extra,
];

test('each role round-trips through its argument', () => {
  for (const role of WINDOW_ROLES) {
    assert.equal(parsePreloadRole(argv(roleArgument(role))), role);
  }
});

test('THE FALLBACK IS THE MOST RESTRICTED ROLE, NOT THE MOST PRIVILEGED', () => {
  // A bug in argument passing must never hand a window the full IPC contract. Defaulting to
  // 'operator' would be exactly the wrong failure direction.
  assert.equal(FALLBACK_ROLE, 'output');
  assert.equal(parsePreloadRole(argv()), 'output');
  assert.equal(parsePreloadRole([]), 'output');
});

test('the fallback surface really is read-only', () => {
  // Guards the claim above: if OUTPUT_ALLOWED_CHANNELS ever gained a mutating channel, the
  // fail-closed default would quietly stop being safe.
  assert.ok(OUTPUT_ALLOWED_CHANNELS.length < IPC_CHANNELS.length);
  for (const channel of OUTPUT_ALLOWED_CHANNELS) {
    assert.doesNotMatch(
      channel,
      /:(save|delete|set|setFavorite|import|assign|intent|restore|discard|quit|open|close|reorder|duplicate|resetDefaults|complete)$/,
      `${channel} must not be reachable from the fail-closed default role`,
    );
  }
});

test('an unrecognised role value falls back instead of being trusted', () => {
  for (const bad of ['admin', 'OPERATOR', 'operator ', '', 'root', '../operator']) {
    assert.equal(
      parsePreloadRole(argv(`${ROLE_ARG_PREFIX}${bad}`)),
      FALLBACK_ROLE,
      `"${bad}" must not be accepted`,
    );
  }
});

test('a role-like argument that is not the exact prefix is ignored', () => {
  assert.equal(parsePreloadRole(argv('--exceptionel-role', 'operator')), FALLBACK_ROLE);
  assert.equal(parsePreloadRole(argv('--role=operator')), FALLBACK_ROLE);
  assert.equal(parsePreloadRole(argv('--x-exceptionel-role=operator')), FALLBACK_ROLE);
});

test('the last occurrence wins, so a later argument overrides an earlier one', () => {
  assert.equal(
    parsePreloadRole(argv(roleArgument('operator'), roleArgument('output'))),
    'output',
  );
  assert.equal(
    parsePreloadRole(argv(roleArgument('output'), roleArgument('operator'))),
    'operator',
  );
});

test('an unknown value after a valid one does NOT silently keep the valid role', () => {
  // Scanning backwards, the malformed argument is seen first and must fail closed rather
  // than fall through to an earlier legitimate one.
  assert.equal(parsePreloadRole(argv(roleArgument('operator'), `${ROLE_ARG_PREFIX}admin`)), FALLBACK_ROLE);
});

test('non-string entries in argv do not throw', () => {
  const dirty = [undefined, null, 42, {}, roleArgument('confidence')] as unknown as string[];
  assert.doesNotThrow(() => parsePreloadRole(dirty));
  assert.equal(parsePreloadRole(dirty), 'confidence');
});

test('the confidence surface can read service context but still cannot mutate', () => {
  assert.ok(CONFIDENCE_ALLOWED_CHANNELS.includes('services:get'));
  for (const channel of CONFIDENCE_ALLOWED_CHANNELS) {
    assert.doesNotMatch(channel, /:(save|delete|set|intent|reorder|quit)$/, channel);
  }
});

test('roleArgument produces the exact prefix the parser expects', () => {
  assert.equal(roleArgument('operator'), '--exceptionel-role=operator');
  assert.ok(roleArgument('output').startsWith(ROLE_ARG_PREFIX));
});
