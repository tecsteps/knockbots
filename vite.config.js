import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Two build targets:
//   `npm run build`     -> normal dist/ (dev/QA, served by any static host)
//   `npm run build:one` -> a single self-contained index.html with three.js,
//                          shaders and all game code inlined. That file is what
//                          gets published as the Artifact, so it must not
//                          reference any external host.
const single = process.env.KB_SINGLEFILE === '1';

export default defineConfig({
  base: './',
  plugins: single ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
  build: {
    target: 'es2022',
    outDir: single ? 'dist-single' : 'dist',
    assetsInlineLimit: single ? 100_000_000 : 4096,
    cssCodeSplit: !single,
    chunkSizeWarningLimit: 4000,
    rollupOptions: single ? { output: { inlineDynamicImports: true } } : {},
    minify: 'esbuild',
  },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
});
