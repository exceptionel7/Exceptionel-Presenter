import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Paths are resolved against THIS FILE's directory, not process.cwd().
 *
 * `resolve('src/main/index.ts')` silently depends on the working directory of whatever
 * launched the build. Run from anywhere but the project root — a parent folder, an IDE
 * task, a monorepo script — and the entry path points at a file that does not exist, which
 * electron-vite reports as "An entry point is required in the electron vite main config".
 */
const projectRoot = dirname(fileURLToPath(import.meta.url));
const fromRoot = (...segments: string[]): string => resolve(projectRoot, ...segments);

/**
 * Three renderer entry points, matching the three window roles in docs/ARCHITECTURE.md §1:
 *
 *   operator   — the full production interface (monitor 1)
 *   output     — the audience screen. No chrome, no controls, ever.
 *   confidence — stage/pastor monitor: current, next, timer, notes
 *
 * They are separate HTML entries rather than routes in one bundle on purpose: the audience
 * output must not be one router mistake away from rendering operator UI.
 */
export default defineConfig({
  /**
   * MAIN — emitted as ESM (.mjs).
   *
   * package.json declares "type": "module", so a .js file here would be parsed as ESM
   * anyway; naming it .mjs makes that explicit and keeps package.json's "main" field
   * unambiguous. src/main/index.ts uses import.meta.url, which requires ESM.
   */
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: fromRoot('out/main'),
      rollupOptions: {
        input: { index: fromRoot('src/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].mjs' },
      },
    },
  },

  /**
   * PRELOAD — ONE CommonJS bundle, self-contained.
   *
   * Two constraints force this exact shape:
   *
   * 1. CommonJS, not ESM. Electron supports ESM preloads only when `sandbox: false`, and
   *    every window here is sandboxed (src/main/security/policy.ts). The extension must be
   *    .cjs rather than .js, because "type": "module" in package.json makes a .js file ESM
   *    and the CommonJS body then fails to evaluate.
   *
   * 2. A SINGLE entry. With three entries (operator/output/confidence) Rollup code-split
   *    their shared bridge code into chunks/bridge-*.cjs, leaving each entry a 0.22 kB stub
   *    that `require`d it. A sandboxed preload cannot require local files, so the require
   *    threw, contextBridge was never reached, and window.exceptionel was undefined — with
   *    no message explaining why. One entry has nothing to split.
   *
   * The window role is passed at runtime via webPreferences.additionalArguments instead.
   * `inlineDynamicImports` guarantees the output stays a single file even if a dynamic
   * import is introduced later.
   */
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: fromRoot('out/preload'),
      rollupOptions: {
        input: { index: fromRoot('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          inlineDynamicImports: true,
        },
      },
    },
  },

  renderer: {
    root: fromRoot('src/renderer'),
    resolve: {
      alias: {
        '@shared': fromRoot('src/shared'),
        '@ui': fromRoot('src/renderer/shared-ui'),
      },
    },
    plugins: [react()],
    build: {
      outDir: fromRoot('out/renderer'),
      rollupOptions: {
        input: {
          operator: fromRoot('src/renderer/operator/index.html'),
          output: fromRoot('src/renderer/output/index.html'),
          confidence: fromRoot('src/renderer/confidence/index.html'),
        },
      },
    },
  },
});
