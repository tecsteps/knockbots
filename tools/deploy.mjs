#!/usr/bin/env node
/**
 * deploy.mjs — build, publish to every configured target, then PROVE each one is
 * actually serving the build we just made.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * For an entire working session every round was announced as "deployed" and every
 * one of those announcements was true — of https://knockbots.vercel.app, a URL the
 * user does not open. They play https://knockbots.com, which is Cloudflare Pages,
 * a completely separate pipeline that nothing in this repo ever pushed to. The two
 * had silently drifted to different builds:
 *
 *     vercel: assets/index-4etCrLQW.js   three.module-CGb8qfv9.js
 *     dotcom: assets/index-BLmWjoEL.js   three.module-xWFAZhSg.js
 *
 * A whole day of work was invisible to the only person who mattered, and nothing
 * anywhere reported a problem, because `vercel deploy` genuinely did succeed.
 *
 * The lesson is the one this project keeps relearning: A DEPLOY THAT SUCCEEDS IS
 * NOT A DEPLOY THAT SHIPPED. "The command exited 0" is the same class of evidence
 * as "the renderer drew something" — it tells you an action happened, not that the
 * result is what you wanted. So the load-bearing part of this file is not the
 * publish step. It is `verify()`, which fetches the LIVE html from each target and
 * diffs its asset hashes against the dist we just built on disk.
 *
 * That check is cheap, it is the one that was missing, and it would have caught
 * this on the first round.
 *
 * ---------------------------------------------------------------------------
 * FAILING LOUDLY IS THE POINT
 * ---------------------------------------------------------------------------
 * A target that cannot be published — no credential, not logged in, unknown
 * project — is a FAILURE, not a skip. Silently doing 1 of 2 targets is the exact
 * bug this file exists to prevent, so an unconfigured target exits non-zero and
 * says what is needed. Use --only=<target> to deliberately publish one, which
 * makes the partial deploy a stated intent rather than an accident.
 *
 * ---------------------------------------------------------------------------
 * SECRETS
 * ---------------------------------------------------------------------------
 * .env holds VERCEL_API_KEY and CLOUDFLARE_API_KEY and is gitignored. Tokens are
 * read into memory, passed to child processes via env, and NEVER printed, logged,
 * echoed into a command line (argv is world-readable via ps), or written to any
 * file. Child stdout is scrubbed through `redact()` before it reaches the console,
 * because CLIs have been known to echo a token back in an error message.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node tools/deploy.mjs                  build, publish everywhere, verify
 *   node tools/deploy.mjs --verify-only    no build, no publish; just report drift
 *   node tools/deploy.mjs --only=vercel    publish one target on purpose
 *   node tools/deploy.mjs --no-build       publish the existing dist/
 *
 * Exit codes: 0 every target verified serving this build. 1 anything else.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ config */

/**
 * Every place the game is published. `verifyUrl` is the URL a PLAYER opens —
 * deliberately not the deploy alias, because the whole failure this file guards
 * against was a deploy alias being healthy while the player-facing host was
 * months stale.
 */
const TARGETS = [
  {
    name: 'vercel',
    verifyUrl: 'https://knockbots.vercel.app',
    envKey: 'VERCEL_API_KEY',
  },
  {
    name: 'cloudflare',
    verifyUrl: 'https://knockbots.com',
    envKey: 'CLOUDFLARE_API_KEY',
  },
];

/* ------------------------------------------------------------------- utils */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const hit = args.find((a) => a.startsWith(`${f}=`));
  return hit ? hit.slice(f.length + 1) : d;
};

const VERIFY_ONLY = has('--verify-only');
const NO_BUILD = has('--no-build') || VERIFY_ONLY;
const ONLY = val('--only');

/** Loaded once, held in memory, never serialised. */
function loadEnv() {
  const out = {};
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const ENV = loadEnv();

/** Every secret we know about, longest first so overlapping values scrub fully. */
const SECRETS = Object.values(ENV)
  .filter((v) => v && v.length >= 8)
  .sort((a, b) => b.length - a.length);

/**
 * Scrub known secret values out of any text before it is displayed. Child CLIs
 * have echoed tokens back inside error messages; this is the last line of defence
 * and it runs on every byte that reaches the console.
 */
function redact(s) {
  let out = String(s);
  for (const sec of SECRETS) out = out.split(sec).join('«redacted»');
  return out;
}

function log(...m) { console.log(...m.map(redact)); }

/** Spawn with args as an array — never a shell string, so no token can land in argv. */
function run(cmd, argv, extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, argv, {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(redact(d.toString())); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(redact(d.toString())); });
    child.on('close', (code) => done({ code, out }));
    child.on('error', (e) => done({ code: -1, out: String(e.message) }));
  });
}

/* ------------------------------------------------------- the actual check */

/** Asset filenames are content-hashed by Vite, so the set of them IS the build id. */
function assetsOf(html) {
  return [...new Set([...html.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((m) => m[0]))].sort();
}

function localAssets() {
  const p = resolve(ROOT, 'dist/index.html');
  if (!existsSync(p)) return null;
  return assetsOf(readFileSync(p, 'utf8'));
}

/**
 * The load-bearing function. Fetch what the world actually sees and compare it to
 * what we actually built. Cache-bust, because a CDN edge holding an old index.html
 * is itself a real deploy failure a player would experience.
 */
async function verify(target, expected) {
  const url = `${target.verifyUrl}/?_cb=${process.hrtime.bigint()}`;
  let html;
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    html = await res.text();
  } catch (e) {
    return { ok: false, why: `unreachable: ${e.message}` };
  }

  const live = assetsOf(html);
  if (!live.length) return { ok: false, why: 'no hashed assets in served html' };
  if (!expected) return { ok: null, why: 'no local dist to compare against', live };

  const missing = expected.filter((a) => !live.includes(a));
  if (missing.length) {
    return { ok: false, why: `serving a DIFFERENT build`, live, expected, missing };
  }
  return { ok: true, live };
}

/* --------------------------------------------------------------- publish */

async function publishVercel() {
  const token = ENV.VERCEL_API_KEY;
  if (!token) return { ok: false, why: 'VERCEL_API_KEY missing from .env' };
  // Token goes through env, never argv (ps would expose argv to any local user).
  const r = await run('npx', ['--yes', 'vercel@latest', 'deploy', '--prod', '--yes', '--prebuilt=false'], {
    VERCEL_TOKEN: token,
  });
  return r.code === 0 ? { ok: true } : { ok: false, why: `vercel exited ${r.code}` };
}

/**
 * Ask Cloudflare what a token can do. The DIAGNOSIS matters more than the boolean:
 * `/accounts` distinguishes failure modes that `/user/tokens/verify` flattens into
 * one unhelpful "1000 Invalid API Token".
 *
 *   CLOUDFLARE_API_KEY   -> 9109 "Invalid access token"                    dead
 *   CLOUDFLARE_API_KEY2  -> 9109 "Cannot use the access token from
 *                                 location: 79.140.115.60"                 VALID, IP-blocked
 *
 * That second one is a real token behind an IP allowlist that does not include this
 * machine — on IPv4 *or* IPv6, both were tried. Telling the user "invalid token"
 * there would send them to mint a new one when the actual fix is one allowlist
 * entry. So this returns the message, not just a pass/fail.
 */
async function probeToken(token) {
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    if (body.success) return { ok: true, accounts: body.result?.map((a) => a.name) ?? [] };
    const msg = body.errors?.[0]?.message ?? 'unknown error';
    return { ok: false, msg, ipBlocked: /from location/i.test(msg) };
  } catch (e) {
    return { ok: false, msg: `network: ${e.message}` };
  }
}

async function publishCloudflare() {
  // Three ways in, tried in order: any working token in .env, then an interactive
  // `wrangler login`. More than one token is supported because .env has carried two
  // with entirely different failure modes, and picking the wrong one silently is how
  // an hour goes missing.
  const candidates = Object.keys(ENV)
    .filter((k) => /^CLOUDFLARE_API_KEY\d*$/.test(k) && ENV[k])
    .sort();

  let token = null;
  const diagnoses = [];
  for (const key of candidates) {
    const p = await probeToken(ENV[key]);
    if (p.ok) {
      log(`  ${key}: authenticated${p.accounts.length ? ` (${p.accounts.join(', ')})` : ''}`);
      token = ENV[key];
      break;
    }
    log(`  ${key}: ${p.msg}`);
    diagnoses.push({ key, ...p });
  }

  const ipBlocked = diagnoses.find((d) => d.ipBlocked);
  if (!token && ipBlocked) {
    return {
      ok: false,
      why: `${ipBlocked.key} is a VALID token blocked by an IP allowlist`,
      fix: [
        `Cloudflare says: ${ipBlocked.msg}`,
        '',
        'This is NOT a bad token — it is the token\'s IP filter. Fix it in one place:',
        '  Cloudflare dashboard -> My Profile -> API Tokens -> (the token) -> Edit',
        '  under "Client IP Address Filtering", either add the address named above',
        '  or remove the restriction entirely.',
        '',
        'A home IP is usually dynamic, so it will drift and this will recur. Removing',
        'the filter and instead scoping the token to "Cloudflare Pages: Edit" on the',
        'one account is the more durable trade.',
        '',
        'Alternative that needs no dashboard visit: run `wrangler login` here.',
      ].join('\n'),
    };
  }

  const project = process.env.KB_CF_PROJECT || ENV.KB_CF_PROJECT;

  const who = await run('npx', ['--yes', 'wrangler@4', 'whoami'],
    token ? { CLOUDFLARE_API_TOKEN: token } : {});
  if (/not authenticated/i.test(who.out) || who.code !== 0) {
    return {
      ok: false,
      why: 'wrangler is not authenticated',
      fix: [
        'The CLOUDFLARE_API_KEY in .env is rejected by the API (verify -> 1000 Invalid API Token).',
        'Either:',
        '  (a) run `wrangler login` in this terminal (interactive, opens a browser), or',
        '  (b) mint a token with the "Cloudflare Pages: Edit" permission and replace',
        '      CLOUDFLARE_API_KEY in .env.',
        'Then set KB_CF_PROJECT to the Pages project name if it is not auto-detected.',
      ].join('\n'),
    };
  }

  let name = project;
  if (!name) {
    const list = await run('npx', ['--yes', 'wrangler@4', 'pages', 'project', 'list'],
      token ? { CLOUDFLARE_API_TOKEN: token } : {});
    const m = /^\s*│?\s*([a-z0-9][a-z0-9-]*)\s*│/im.exec(list.out);
    name = m?.[1];
    if (!name) return { ok: false, why: 'could not determine the Pages project name; set KB_CF_PROJECT' };
    log(`  detected Pages project: ${name}`);
  }

  const r = await run('npx', ['--yes', 'wrangler@4', 'pages', 'deploy', 'dist',
    `--project-name=${name}`, '--branch=main', '--commit-dirty=true'],
    token ? { CLOUDFLARE_API_TOKEN: token } : {});
  return r.code === 0 ? { ok: true } : { ok: false, why: `wrangler exited ${r.code}` };
}

const PUBLISH = { vercel: publishVercel, cloudflare: publishCloudflare };

/* ------------------------------------------------------------------ main */

async function main() {
  const targets = ONLY ? TARGETS.filter((t) => t.name === ONLY) : TARGETS;
  if (!targets.length) {
    console.error(`unknown --only=${ONLY}; known: ${TARGETS.map((t) => t.name).join(', ')}`);
    process.exit(1);
  }
  if (ONLY) log(`NOTE: --only=${ONLY}; other targets will drift and that is on purpose.\n`);

  if (!NO_BUILD) {
    log('building…');
    const b = await run('npm', ['run', 'build']);
    if (b.code !== 0) { console.error('build failed'); process.exit(1); }
  }

  const expected = localAssets();
  if (!expected && !VERIFY_ONLY) { console.error('no dist/index.html — build first'); process.exit(1); }
  if (expected) log(`\nlocal build: ${expected.join('  ')}\n`);

  const results = [];

  if (!VERIFY_ONLY) {
    for (const t of targets) {
      log(`── publishing ${t.name} ──`);
      const r = await PUBLISH[t.name]();
      if (!r.ok) {
        log(`  ✗ ${t.name}: ${r.why}`);
        if (r.fix) log(`\n${r.fix}\n`);
      }
      results.push({ target: t, publish: r });
    }
  } else {
    for (const t of targets) results.push({ target: t, publish: null });
  }

  // Verification runs even for targets whose publish failed — that is how we learn
  // WHAT they are serving instead, which is the fact that actually matters.
  log(`\n── verifying what each host actually serves ──`);
  let bad = 0;
  for (const r of results) {
    const v = await verify(r.target, expected);
    r.verify = v;
    const label = `${r.target.name.padEnd(11)} ${r.target.verifyUrl}`;
    if (v.ok === true) {
      log(`  ✓ ${label}  serving this build`);
    } else if (v.ok === null) {
      log(`  ? ${label}  ${v.why}`);
    } else {
      bad++;
      log(`  ✗ ${label}  ${v.why}`);
      if (v.live) log(`      live: ${v.live.join('  ')}`);
      if (v.missing) log(`      ours: ${v.missing.join('  ')}`);
    }
  }

  if (bad) {
    log(`\nFAIL — ${bad} of ${results.length} target(s) are not serving this build.`);
    log('A green publish step does not mean a player sees the change. That is the');
    log('entire reason this file exists; do not announce a deploy on a red verify.');
    process.exit(1);
  }
  log(`\nOK — all ${results.length} target(s) verified serving this build.`);
}

main().catch((e) => { console.error(redact(e?.stack || e)); process.exit(1); });
