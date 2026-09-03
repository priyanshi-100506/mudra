/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// extension/ — where all node_modules live
const extensionRoot = __dirname;
// Workspace root (clio/) — one level above extension/
const workspaceRoot = resolve(extensionRoot, '..');
// Absolute path to the only node_modules in this monorepo
const nodeModules = resolve(extensionRoot, 'node_modules');

/**
 * Vitest-only configuration.
 *
 * Layout challenge:  test files live in  <workspaceRoot>/tests/
 *                    node_modules live in <workspaceRoot>/extension/node_modules/
 *
 * Fix: `resolve.modules` accepts ABSOLUTE paths, so adding the extension
 * node_modules directory here makes Vite resolve `vitest`, `jsdom`, etc.
 * correctly even when the importer is outside the extension/ tree.
 *
 * Run: npx vitest run --config vitest.config.ts
 */
export default defineConfig({
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  resolve: {
    alias: {
      vitest: resolve(nodeModules, 'vitest'),
    },
    modules: [nodeModules, 'node_modules'],
  },
  test: {
    environment: 'jsdom',
    root: workspaceRoot,
    include: ['tests/**/*.test.ts'],
  },
});
