/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const extensionRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(extensionRoot, '..');
const nodeModules = resolve(extensionRoot, 'node_modules');

/**
 * Config for the evaluation harness.
 *
 * It lives here rather than in eval/ because only this directory has
 * node_modules — the same constraint vitest.config.ts already works around.
 *
 * The harness runs under Vitest purely as a TypeScript runner: it imports the
 * extension's real modules and writes results.json. It is not part of the
 * test suite. A test asserts; this measures, and keeping it separate means a
 * disappointing number fails nothing — which is the only way the numbers stay
 * honest.
 */
export default defineConfig({
  server: { fs: { allow: [workspaceRoot] } },
  resolve: {
    alias: {
      vitest: resolve(nodeModules, 'vitest'),
      // The harness builds a document per fixture, so it imports jsdom
      // directly rather than running in a jsdom environment. The alias is
      // needed because eval/ sits outside the directory holding node_modules.
      jsdom: resolve(nodeModules, 'jsdom'),
    },
    modules: [nodeModules, 'node_modules'],
  },
  test: {
    // jsdom, because the content modules bind window listeners at import
    // time — the same conditions they run under in a page. The harness still
    // builds a fresh JSDOM per fixture, so each page starts from a clean
    // document rather than inheriting the previous one's.
    environment: 'jsdom',
    root: workspaceRoot,
    include: ['eval/harness.spec.ts'],
    testTimeout: 120_000,
  },
});
