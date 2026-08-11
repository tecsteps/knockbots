/**
 * Knockbots — turn the single-file build into an Artifact page.
 *
 * `npm run build:one` emits a complete HTML document. An Artifact is not a
 * document: the host supplies `<!doctype html><head>…</head><body>` and drops
 * this file's contents inside the body, inside an IFRAME on claude.ai. Two
 * things follow from that, and the second one is why the first published build
 * never started.
 *
 * 1. The document furniture has to go. `<html>`, `<head>`, `<body>` and the
 *    external analytics beacon are stripped; the styles and the module script
 *    are kept and simply land in the body, which is legal and works.
 *
 * 2. THE FRAME IS AUTO-HEIGHT. The host's frame runtime watches
 *    `document.documentElement.scrollHeight` and sizes the iframe to it. The
 *    game's own CSS is written for a browser tab: `html, body { height: 100% }`
 *    with `#app`, `#ui` and `#boot` all `position: fixed`. Fixed boxes
 *    contribute nothing to scroll height, so the only thing left defining it is
 *    `height: 100%` — of the iframe. The measurement is therefore circular: the
 *    content is exactly as tall as the frame already is, so the frame can hold
 *    its size or shrink but can never grow. Published, it opened as a sliver
 *    and the game "did not start" — it had started, into a canvas a few pixels
 *    high.
 *
 *    The fix is to give the page a height that does NOT come from the viewport.
 *    Everything moves into a stage div sized by `aspect-ratio` off its own
 *    width, and the fixed boxes become absolute within it. `scrollHeight` is
 *    then a real number the host can act on, and it tracks the frame's width.
 *
 * Usage: node tools/artifact.mjs [--in dist-single/index.html] [--out <path>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const IN = resolve(ROOT, arg('in', 'dist-single/index.html'));
const OUT = resolve(ROOT, arg('out', 'dist-single/artifact.html'));

const src = readFileSync(IN, 'utf8');
const head = src.slice(src.indexOf('<head>') + 6, src.indexOf('</head>'));
const body = src.slice(src.indexOf('<body>') + 6, src.lastIndexOf('</body>'));

const stripped = body
  // A strict CSP refuses every external host, so a beacon can only produce a
  // console error on a published page.
  .replace(/<script[^>]*src="https?:\/\/[^"]*"[^>]*>\s*<\/script>/g, '');

const headKept = head
  // The host writes its own <title> and charset; a second one is ignored at
  // best and confusing at worst.
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<meta charset[^>]*>/g, '')
  // A viewport meta in the body does nothing, and the host has already set one.
  .replace(/<meta name="viewport"[^>]*>/g, '');

/**
 * The stage. `aspect-ratio` is the whole point: it derives a height from the
 * width, which the frame does know, instead of from the height, which is what
 * the frame is trying to work out.
 *
 * There is deliberately NO viewport-unit cap on it. A `max-height: 88dvh` looks
 * like a sensible guard and puts the circularity straight back: dvh is a
 * fraction of the frame height, so a frame that opens small clamps the stage
 * small and the page has no way back out. Width is the only dimension the frame
 * knows independently, so width is the only thing the height may come from.
 */
const OVERRIDE = `
<style>
  /* Artifact frame overrides — see tools/artifact.mjs for why these exist. */
  html, body { height: auto !important; overflow: visible !important; background: #05070c; }
  #kb-stage {
    position: relative; width: 100%; aspect-ratio: 16 / 9;
    overflow: hidden; background: #05070c;
  }
  #kb-stage > #app, #kb-stage > #ui, #kb-stage > #boot { position: absolute !important; inset: 0 !important; }
  #kb-stage canvas { width: 100% !important; height: 100% !important; }
  /* The boot legend is written for a full page; inside a 16:9 stage it needs to
     be able to scroll rather than push the layout open. */
  #kb-stage > #boot { overflow: auto; }
</style>
<script>
  /* Classic, not module: this must run while the document is still parsing, so
     that the stage exists before the deferred module script measures anything.
     The three roots are already in the DOM above this tag. */
  (function () {
    var stage = document.createElement('div');
    stage.id = 'kb-stage';
    var first = document.getElementById('app');
    if (!first) return;
    first.parentNode.insertBefore(stage, first);
    ['app', 'ui', 'boot'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) stage.appendChild(el);
    });
    /* Keyboard play needs the frame focused, and a click inside an iframe does
       not always give it focus on its own. */
    stage.addEventListener('pointerdown', function () {
      try { window.focus(); } catch (e) { /* cross-origin parent, nothing to do */ }
    });
  })();
</script>
`;

/*
 * Vite emits the module script into the HEAD, above the markup it operates on.
 * That is fine in a document -- a module script is deferred, so it runs after
 * parsing -- but the stage has to be built by a CLASSIC script, which runs the
 * moment it is parsed, and it can only move `#app`, `#ui` and `#boot` once they
 * exist. So the module script is lifted out of the head and re-emitted last,
 * after the markup and after the stage script. Deferred or not, ordering it
 * explicitly is what makes the sequence readable.
 */
const MODULE_RE = /<script type="module"[^>]*>[\s\S]*<\/script>/;
const moduleTag = headKept.match(MODULE_RE)?.[0];
if (!moduleTag) throw new Error('no module script found in the single-file build head');
const styles = headKept.replace(MODULE_RE, '');

const out = `${styles.trim()}\n${stripped.trim()}\n${OVERRIDE}\n${moduleTag}\n`;

writeFileSync(OUT, out);
console.log(`[artifact] ${(out.length / 1048576).toFixed(2)} MB -> ${OUT}`);
