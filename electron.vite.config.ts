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
   * PRELOAD — emitted as CommonJS (.cjs).
   *
   * This is not a style choice. Electron only supports ESM preload scripts when
   * `sandbox: false`, and every window here runs with `sandbox: true` (see
   * src/main/security/policy.ts). So preloads must be CJS.
   *
   * The extension must be .cjs rather than .js: with "type": "module" in package.json, a
   * .js file is treated as ESM and the CommonJS body fails to evaluate.
   */
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: fromRoot('out/preload'),
      rollupOptions: {
        input: {
          // Role-scoped. The output preload deliberately exposes a read-only surface —
          // see src/preload/output.ts
          operator: fromRoot('src/preload/operator.ts'),
          output: fromRoot('src/preload/output.ts'),
          confidence: fromRoot('src/preload/confidence.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
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
