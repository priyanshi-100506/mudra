import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Content scripts run as classic scripts — they must be one self-contained
// file with no imports. So they get their own build pass.
const isContent = process.env.BUILD_TARGET === 'content';

export default defineConfig({
  plugins: [react()],
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
            background: resolve(__dirname, 'src/background/service-worker.ts'),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === 'background'
                ? 'src/background/service-worker.js'
                : 'assets/[name]-[hash].js',
          },
        },
      },
});
