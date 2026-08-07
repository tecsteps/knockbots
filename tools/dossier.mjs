/**
 * Knockbots — build-dossier updater.
 *
 * The dossier is published as an Artifact, and Artifacts are served under a
 * strict CSP that blocks every external host. That means screenshots cannot be
 * referenced by path — they have to be embedded as data URIs. This tool reads
 * the JPEGs in docs/shots/, inlines them, and rewrites the marked regions of
 * docs/buildlog.html in place.
 *
 * Regions are delimited by HTML comments so the surrounding hand-written design
 * is never touched:
 *   <!--GALLERY-->   ... <!--/GALLERY-->
 *   <!--VERDICT-->   ... <!--/VERDICT-->
 *   <!--LOG-->       ... <!--/LOG-->
 *   <!--STATUS-->    ... <!--/STATUS-->
 *
 *   node tools/dossier.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = resolve(ROOT, 'docs/buildlog.html');
const SHOTS = resolve(ROOT, 'docs/shots');
const META = resolve(ROOT, 'docs/dossier.json');

/** Human captions per capture, keyed by filename stem. */
const CAPTIONS = {
  '01-hero-idle': ['Default fight framing', 'Both fighters idle at neutral. The baseline play view.'],
  '02-closeup-face': ['Head and chest', 'Material, panel break-up and emissive detail up close.'],
  '03-full-body': ['Full body', 'Silhouette and proportion read at three-quarter.'],
  '04-impact': ['Impact frame', 'Mid-combo contact — sparks, hitstop, camera punch.'],
  '05-juggle': ['Juggle', 'Airborne pose readability off the ground.'],
  '06-stage-wide': ['Arena wide', 'Environment, depth cues and volumetrics.'],
  '07-super': ['Overdrive', 'The super cinematic.'],
  '08-hud': ['Play view', 'Full composition with the interface.'],
  '09-roster': ['Roster lineup', 'Silhouette variety across the cast.'],
  '10-ko': ['K.O.', 'The dramatic beat, in slow motion.'],
  'diag-nopost': ['Diagnostic — post disabled', 'Bloom, DOF, SSR and motion blur off, isolating the atmosphere wash.'],
};

/*
 * WHY THE GALLERY IS RE-ENCODED AND NOT EMBEDDED AS CAPTURED.
 *
 * The captures are 1920x1080 JPEGs at capture quality, 17 MB across 28 files.
 * Base64 costs another 37%, which put the page at 22.9 MB and over the 16 MB
 * ceiling the Artifact host enforces. The publish failed outright -- not
 * degraded, refused -- so the dossier silently stopped being publishable at
 * some point between the shot list growing and anyone trying.
 *
 * Every image here is displayed in a card a few hundred pixels wide and opened
 * at most to the viewport width, so 1440px is already more than the page can
 * show. Resampling to that and re-encoding at quality 62 is invisible at the
 * sizes the page uses and takes the payload to roughly a quarter.
 *
 * `sips` ships with macOS, which is where this runs. If it is missing, or if it
 * fails on a file, the original bytes go in unchanged: a dossier with a big
 * gallery is a better failure than a dossier with holes in it. The size is
 * reported either way, because a silent fallback that puts the page back over
 * the ceiling would be the same defect wearing a different hat.
 *
 * The re-encode never touches `docs/shots/`. Those are the certified archive
 * the critics score, and nothing in a presentation tool has any business
 * rewriting them.
 */
const EMBED_W = 1440;
const EMBED_Q = 62;
const CACHE = resolve(ROOT, 'scratchpad/dossier-embed');
let sipsOk = true;
const shrunk = [];

function dataUri(file) {
  const ext = file.endsWith('.png') ? 'png' : 'jpeg';
  let buf = readFileSync(file);

  if (sipsOk && ext === 'jpeg') {
    try {
      mkdirSync(CACHE, { recursive: true });
      const out = resolve(CACHE, basename(file));
      execFileSync('sips', [
        '-Z', String(EMBED_W),
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(EMBED_Q),
        file, '--out', out,
      ], { stdio: 'ignore' });
      const small = readFileSync(out);
      // Only take it if it actually helped. A capture that is already smaller
      // than the re-encode has nothing to gain and would only lose detail.
      if (small.length < buf.length) { shrunk.push([basename(file), buf.length, small.length]); buf = small; }
    } catch (e) {
      if (sipsOk) console.warn(`[dossier] sips unavailable (${e.code || e.message}); embedding originals`);
      sipsOk = false;
    }
  }
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function replaceRegion(html, name, body) {
  const re = new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->`);
  const block = `<!--${name}-->${body}<!--/${name}-->`;
  return re.test(html) ? html.replace(re, block) : html;
}

function buildGallery() {
  if (!existsSync(SHOTS)) return '<div class="pending">No captures yet</div>';
  const files = readdirSync(SHOTS).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  if (!files.length) return '<div class="pending">No captures yet</div>';

  let total = 0;
  const cards = files.map((f) => {
    const stem = basename(f).replace(/\.(jpg|jpeg|png)$/i, '');
    const [title, note] = CAPTIONS[stem] || [stem.replace(/^\d+-/, '').replace(/-/g, ' '), ''];
    const uri = dataUri(resolve(SHOTS, f));
    total += uri.length;
    return `
        <figure class="capture">
          <img src="${uri}" alt="${esc(title)}" loading="lazy">
          <figcaption class="meta"><b>${esc(title)}</b><span>${esc(note)}</span></figcaption>
        </figure>`;
  });
  console.log(`[dossier] embedded ${files.length} captures, ${(total / 1024 / 1024).toFixed(2)} MB of data URI`);
  return cards.join('');
}

function buildVerdict(meta) {
  const axes = meta.verdicts || [];
  if (!axes.length) {
    return ['Character rendering', 'Animation quality', 'Lighting & atmosphere', 'Impact & effects', 'Stage detail', 'Interface craft']
      .map((a) => `
        <div class="row"><span>${esc(a)}</span><div class="meter"><i style="width:0%"></i></div><span class="score">—</span></div>`)
      .join('');
  }
  return axes.map((v) => {
    const pass = v.score >= 80;
    return `
        <div class="row">
          <span>${esc(v.axis)}</span>
          <div class="meter"><i style="width:${Math.max(0, Math.min(100, v.score))}%"></i></div>
          <span class="score" style="color:${pass ? 'var(--good)' : 'var(--danger)'}">${v.score}</span>
        </div>`;
  }).join('');
}

function buildLog(meta) {
  return (meta.log || []).map((e) => `
        <article class="entry">
          <div class="stamp"><b>${esc(e.phase)}</b>${esc(e.when)}${e.rev ? `<br>${esc(e.rev)}` : ''}</div>
          <div class="body">
            <h3>${esc(e.title)}</h3>
            ${(e.paras || []).map((p) => `<p>${esc(p)}</p>`).join('\n            ')}
            ${(e.tags || []).map((t) => `<span class="tag ${t.state || ''}">${esc(t.label ?? t)}</span>`).join('')}
          </div>
        </article>`).join('');
}

function buildDeploy(meta) {
  const d = meta.deploy;
  if (!d || !d.url) return '<div class="pending">Deploy pending</div>';
  return `
      <div class="deploy">
        <a class="go" href="${esc(d.url)}" target="_blank" rel="noopener">Launch build</a>
        <div class="meta">
          <div class="url">${esc(d.url)}</div>
          <div>revision <b>${esc(d.rev ?? '—')}</b> &nbsp;·&nbsp; ${esc(d.note ?? '')}</div>
        </div>
      </div>`;
}

function buildStatus(meta) {
  const s = meta.status || {};
  const rows = [
    ['Revision', s.rev ?? '—'],
    ['Engine', 'three r185'],
    ['Sim rate', '60 Hz fixed'],
    ['Commits', s.commits ?? '—'],
    ['Modules', s.modules ?? '—'],
    ['Lines', s.lines ?? '—'],
    ['Clips', s.clips ?? '—'],
    ['Moves', s.moves ?? '—'],
    ['Characters', s.characters ?? '—'],
  ];
  return rows.map(([k, v]) => `
      <div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

const meta = existsSync(META) ? JSON.parse(readFileSync(META, 'utf8')) : {};
let html = readFileSync(PAGE, 'utf8');
html = replaceRegion(html, 'GALLERY', buildGallery());
html = replaceRegion(html, 'DEPLOY', buildDeploy(meta));
html = replaceRegion(html, 'VERDICT', buildVerdict(meta));
if (meta.log) html = replaceRegion(html, 'LOG', buildLog(meta));
if (meta.status) html = replaceRegion(html, 'STATUS', buildStatus(meta));
writeFileSync(PAGE, html);
console.log(`[dossier] wrote ${PAGE} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
