import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Three renderer entry points, matching the three window roles described in
 * docs/ARCHITECTURE.md §1:
 *
 *   operator   — the full production interface (monitor 1)
 *   output     — the audience screen. No chrome, no controls, ever.
 *   confidence — stage/pastor monitor: current, next, timer, notes
 *
 * They are separate HTML entries rather than routes in one bundle on purpose: the
 * audience output must not be one router mistake away from rendering operator UI.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // Role-scoped preloads. The output preload deliberately exposes a
          // read-only surface — see src/preload/output.ts
          operator: resolve('src/preload/operator.ts'),
          output: resolve('src/preload/output.ts'),
          confidence: resolve('src/preload/confidence.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@ui': resolve('src/renderer/shared-ui'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          operator: resolve('src/renderer/operator/index.html'),
          output: resolve('src/renderer/output/index.html'),
          confidence: resolve('src/renderer/confidence/index.html'),
        },
      },
    },
  },
});
