import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';

// Content scripts run as classic scripts — they must be one self-contained
// file with no imports. So they get their own build pass.
const isContent = process.env.BUILD_TARGET === 'content';

/**
 * Copies the ONNX Runtime WASM binaries out of node_modules and into
 * `dist/wasm/`, and the committed model weights into `dist/models/`.
 *
 * MUDRA's privacy claim only holds if inference is genuinely local, so
 * nothing may be fetched from a CDN at runtime — `ort.env.wasm.wasmPaths`
 * points at this output directory. The binaries are not committed, though:
 * they ship inside the npm package and their version is pinned by
 * package-lock.json, which keeps multi-megabyte artefacts out of git history
 * while still producing an offline build. The model weights are the one
 * binary that is committed, because there is no package to pin them to.
 */
function copyRuntimeAssets(): Plugin {
  return {
    name: 'mudra-copy-runtime-assets',
    apply: 'build',
    closeBundle() {
      const out = resolve(__dirname, 'dist');
      const copyInto = (destDir: string, files: Array<[string, string]>) => {
        fs.mkdirSync(destDir, { recursive: true });
        for (const [from, name] of files) {
          if (fs.existsSync(from)) fs.copyFileSync(from, resolve(destDir, name));
          else this.warn(`runtime asset missing, build will fail closed: ${from}`);
        }
      };

      // ONNX Runtime. The `.jsep` build is the one that carries the WebGPU
      // execution provider; the plain build is the WASM fallback. Both are
      // copied because which one loads is decided at runtime.
      const ortDist = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      const ortFiles = [
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.jsep.mjs',
      ];
      copyInto(resolve(out, 'wasm'), ortFiles.map((f) => [resolve(ortDist, f), f]));

      // Committed weights and anything else under public/.
      const pub = resolve(__dirname, 'public');
      if (fs.existsSync(pub)) {
        fs.cpSync(pub, out, { recursive: true });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isContent = mode === 'content';

  return {
  plugins: [react(), ...(isContent ? [] : [copyRuntimeAssets()])],
  build: isContent
    ? {
        outDir: 'dist',
        emptyOutDir: false,
        rollupOptions: {
          input: { content: resolve(__dirname, 'src/content/index.ts') },
          output: {
            format: 'iife',
            entryFileNames: 'src/content/index.js',
            inlineDynamicImports: true,
            assetFileNames: 'assets/content-[hash][extname]',
          },
        },
      }
    : {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
          input: {
            popup: resolve(__dirname, 'index.html'),
            sidepanel: resolve(__dirname, 'sidepanel/index.html'),
            background: resolve(__dirname, 'src/background/service-worker.ts'),
            offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === 'background'
                ? 'src/background/service-worker.js'
                : 'assets/[name]-[hash].js',
          },
        },
      },
  };
});
