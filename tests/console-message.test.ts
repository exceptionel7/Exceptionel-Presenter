import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConsoleMessage } from '../src/main/windows/console-message.ts';

test('reads the NEW single-object shape', () => {
  const result = readConsoleMessage([
    { level: 'warning', message: 'something odd', lineNumber: 42, sourceId: 'app.js' },
  ]);
  assert.deepEqual(result, { severity: 'warning', text: 'something odd', line: 42, sourceId: 'app.js' });
});

test('reads the OLD positional shape, skipping the event object', () => {
  const result = readConsoleMessage([{ preventDefault() {} }, 3, 'boom', 7, 'main.tsx']);
  assert.deepEqual(result, { severity: 'error', text: 'boom', line: 7, sourceId: 'main.tsx' });
});

test('numeric levels map to Chromium severities', () => {
  assert.equal(readConsoleMessage([{}, 0, 'verbose'])?.severity, 'info');
  assert.equal(readConsoleMessage([{}, 1, 'info'])?.severity, 'info');
  assert.equal(readConsoleMessage([{}, 2, 'warn'])?.severity, 'warning');
  assert.equal(readConsoleMessage([{}, 3, 'error'])?.severity, 'error');
});

test('string levels map, including the aliases Electron has used', () => {
  for (const [level, expected] of [
    ['debug', 'debug'],
    ['verbose', 'debug'],
    ['log', 'info'],
    ['info', 'info'],
    ['warning', 'warning'],
    ['warn', 'warning'],
    ['error', 'error'],
    ['ERROR', 'error'],
  ] as const) {
    assert.equal(readConsoleMessage([{ level, message: 'x' }])?.severity, expected, level);
  }
});

test('missing line and source degrade to defaults rather than undefined', () => {
  const result = readConsoleMessage([{ level: 'info', message: 'no location' }]);
  assert.equal(result?.line, 0);
  assert.equal(result?.sourceId, '');
});

test('AN UNRECOGNISED SHAPE RETURNS NULL RATHER THAN THROWING', () => {
  // This runs inside a main-process event handler. Throwing here would be far worse than
  // losing one log line, and a future Electron signature change must not take the app down.
  for (const args of [
    [],
    [{}],
    [undefined],
    [null],
    ['just a string'],
    [{ level: 'warning' }], // no message
    [{ message: 'x' }], // no level
    [{ level: 'nonsense', message: 'x' }],
    [{ level: 99, message: 'x' }],
  ]) {
    assert.doesNotThrow(() => readConsoleMessage(args as unknown[]));
    assert.equal(readConsoleMessage(args as unknown[]), null, JSON.stringify(args));
  }
});

test('the new shape is preferred when both could match', () => {
  // Defensive against a transitional Electron that passes an object AND positional args.
  const result = readConsoleMessage([
    { level: 'error', message: 'from object', lineNumber: 1, sourceId: 'a.js' },
    2,
    'from positional',
  ]);
  assert.equal(result?.text, 'from object');
});

test('a real Electron security warning is parsed intact', () => {
  // The actual message observed on Windows, which is what prompted this module.
  const text =
    'Electron Security Warning (Insecure Content-Security-Policy) This renderer process ' +
    'has either no Content Security Policy set or a policy with "unsafe-eval" enabled.';
  const result = readConsoleMessage([{ level: 'warning', message: text, lineNumber: 2, sourceId: 'node:electron/js2c/sandbox_bundle' }]);
  assert.equal(result?.severity, 'warning');
  assert.match(result?.text ?? '', /Insecure Content-Security-Policy/);
});
