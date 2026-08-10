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
  // The "no external host" rule above cannot be enforced by inlining alone:
  // the analytics client fetches its own script from va.vercel-scripts.com at
  // runtime, so a single-file build published anywhere else spends its first
  // second on a request that a strict CSP answers with a console error. The
  // build target is the only thing that knows, so it says so.
  define: { __KB_SINGLEFILE__: JSON.stringify(single) },
  build: {
    target: 'es2022',
    outDir: single ? 'dist-single' : 'dist',
    assetsInlineLimit: single ? 100_000_000 : 4096,
    cssCodeSplit: !single,
    chunkSizeWarningLimit: 4000,
    rollupOptions: single ? { output: { inlineDynamicImports: true } } : {},
    // Vite 8 ships rolldown + oxc; esbuild is no longer bundled.
    minify: true,
  },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
});
