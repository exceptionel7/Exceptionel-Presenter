#!/usr/bin/env node
/**
 * EXCEPTIONEL PRESENTER — the typecheck gate that works without node_modules.
 *
 * WHY THIS EXISTS. `npm run typecheck` is the complete gate, but it needs installed
 * dependencies. In an environment where `npm install` is impossible, the only available check was a
 * hand-rolled `tsc` invocation — and the flags that made it run also made it blind.
 *
 * That blindness had a cost. `src/renderer/output/OutputApp.tsx` called
 * `useWirelessCameraHost()` without importing it. The output window therefore threw on its first
 * render, mounted no React tree, and subscribed to no IPC events — so every phone's `ready` message
 * was delivered to a renderer that was not listening, no WebRTC offer was ever created, and the
 * Wireless Camera could not work at all. The window is hidden, so nothing was visible on screen.
 * `tsc` had reported it as TS2304 the whole time; the check was filtering for syntax errors only.
 *
 * TWO PASSES, because the renderer imports React and Tailwind types that cannot be resolved here:
 *
 *   1. MAIN / PRELOAD / SHARED / TESTS — fully typechecked against local shims. Every error fatal.
 *   2. RENDERER — parsed and name-resolved, but module resolution is off. Only errors that are
 *      still MEANINGFUL without resolution are fatal; see FATAL_WITHOUT_RESOLUTION.
 *
 * Run with: node tools/local-typecheck/check.mjs
 */

import { execFileSync } from 'node:child_process';

const SHARED_FLAGS = [
  '--noEmit',
  // --ignoreConfig: the real tsconfigs extend presets and reference node_modules types.
  '--ignoreConfig',
  '--strict',
  '--target', 'es2023',
  '--module', 'preserve',
  '--moduleResolution', 'bundler',
  '--allowImportingTsExtensions',
  '--skipLibCheck',
  '--types', '',
];

/**
 * Error codes that remain trustworthy when modules cannot be resolved.
 *
 * An ALLOW-list of fatal codes, not a deny-list of noise: a deny-list silently forgives every code
 * nobody has thought about yet, which is exactly how TS2304 went unnoticed.
 */
const FATAL_WITHOUT_RESOLUTION = new Map([
  // Anything TS1xxx is a syntax error and is handled by the range check below.
  ['TS2304', "Cannot find name — a missing import or a typo. This is the OutputApp bug."],
  ['TS2552', 'Cannot find name (with a suggestion) — almost always a typo.'],
  ['TS2448', 'Used before declaration — the temporal dead zone bug that broke main once already.'],
  ['TS2454', 'Used before being assigned.'],
  ['TS2451', 'Redeclared block-scoped variable.'],
  ['TS2588', 'Assignment to a constant.'],
  ['TS2678', 'Unreachable case in a switch.'],
  ['TS7027', 'Unreachable code.'],
  ['TS2540', 'Assignment to a read-only property.'],
  ['TS18004', 'No value exists in scope for a shorthand property.'],
]);

const tsc = (files, extraFlags = []) => {
  try {
    execFileSync('npx', ['tsc', ...SHARED_FLAGS, ...extraFlags, ...files], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
};

const expand = (patterns) =>
  execFileSync('bash', ['-c', `shopt -s globstar nullglob; ls -1 ${patterns.join(' ')}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

let failed = false;

// ── pass 1: everything that can be fully typechecked ────────────────────────────

const nodeFiles = expand([
  'tools/local-typecheck/electron-shims.d.ts',
  'tools/local-typecheck/node-shims.d.ts',
  'src/main/**/*.ts',
  'src/preload/**/*.ts',
  'src/shared/**/*.ts',
  'tests/*.test.ts',
]);

const nodeOutput = tsc(nodeFiles, ['--erasableSyntaxOnly', '--noUncheckedIndexedAccess']);
if (nodeOutput.trim()) {
  failed = true;
  console.error('MAIN / PRELOAD / SHARED / TESTS — typecheck failed:\n');
  console.error(nodeOutput);
} else {
  console.log(`✓ main, preload, shared and tests typecheck clean (${nodeFiles.length} files)`);
}

// ── pass 2: the renderer, without module resolution ─────────────────────────────

const rendererFiles = expand(['src/renderer/**/*.ts', 'src/renderer/**/*.tsx']);
const rendererOutput = tsc(rendererFiles, ['--noResolve', '--jsx', 'react-jsx']);

const problems = [];
for (const line of rendererOutput.split('\n')) {
  const match = /error (TS\d+):/.exec(line);
  if (!match) continue;

  const code = match[1];
  const number = Number(code.slice(2));

  // TS1000–TS1999 are syntax errors. They are always real, resolution or not.
  if (number >= 1000 && number < 2000) {
    problems.push({ line, why: 'syntax error' });
    continue;
  }

  const why = FATAL_WITHOUT_RESOLUTION.get(code);
  if (why) problems.push({ line, why });
}

if (problems.length > 0) {
  failed = true;
  console.error(`\nRENDERER — ${problems.length} real problem(s):\n`);
  for (const problem of problems) console.error(`${problem.line}\n    → ${problem.why}\n`);
} else {
  console.log(`✓ renderer parses and resolves every name (${rendererFiles.length} files)`);
  console.log('  NOTE: type COMPATIBILITY in the renderer needs `npm run typecheck` with');
  console.log('        node_modules present. This pass cannot see React or Tailwind types.');
}

process.exit(failed ? 1 : 0);
