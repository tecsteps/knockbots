import { Game } from './core/Game.js';
import { renderControlLegend } from './core/ControlLegend.js';

const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const bar = document.querySelector('#bar i');

function progress(label, pct) {
  if (bootStatus) bootStatus.textContent = label;
  if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
}

const bootStart = performance.now();

async function main() {
  // Draw the control legend before anything expensive starts, so it is readable
  // for the whole of the load rather than flashing up at the end of it. A
  // gamepad connected after this point still re-renders, because the pad is not
  // visible to the page until it reports its first input.
  renderControlLegend(document);
  window.addEventListener('gamepadconnected', () => renderControlLegend(document), { once: true });

  const game = new Game(document.getElementById('app'), document.getElementById('ui'), progress);
  try {
    await game.init();
  } catch (err) {
    console.error('[knockbots] init failed', err);
    if (bootStatus) {
      bootStatus.textContent = 'Boot failure — see console';
      bootStatus.style.color = '#ff6b6b';
    }
    throw err;
  }
  game.start();

  // Expose for the automated visual-QA harness and for debugging. The move
  // table rides along so tools/animstrip.mjs can drive real moves through the
  // fighter state machine rather than poking the animator behind its back.
  window.KB = game;
  window.KB.MOVES = (await import('./combat/Moves.js')).MOVES;
  // The capture harness has to freeze on the exact contact frame: impact sparks
  // live 160-300ms, so a fixed settle delay photographs an empty floor.
  window.KB.bus = (await import('./core/Bus.js')).bus;
  // Also for the harness: the closeup shot has to prove the head is actually
  // visible before it photographs it, and an occlusion test needs a Raycaster.
  // Character was scored for several rounds on frames where a pauldron had
  // swung in front of the subject. See tools/capture.mjs, 02-closeup-face.
  window.KB.THREE = await import('three');
  window.dispatchEvent(new CustomEvent('knockbots:ready'));

  // Hold the boot screen long enough for the control legend to actually be
  // read. On a warm load the game is ready in well under a second, which would
  // flash the mapping past before anyone could take it in. The floor stays
  // under the capture harness's 2.5s settle so shots are never contaminated.
  const MIN_LEGEND_MS = 2000;
  const remaining = Math.max(0, MIN_LEGEND_MS - (performance.now() - bootStart));
  setTimeout(() => boot?.classList.add('hidden'), remaining);
  setTimeout(() => boot?.remove(), remaining + 650);
}

main();
