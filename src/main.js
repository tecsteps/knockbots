import { Game } from './core/Game.js';

const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const bar = document.querySelector('#bar i');

function progress(label, pct) {
  if (bootStatus) bootStatus.textContent = label;
  if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
}

async function main() {
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

  // Expose for the automated visual-QA harness and for debugging.
  window.KB = game;
  window.dispatchEvent(new CustomEvent('knockbots:ready'));

  setTimeout(() => boot?.classList.add('hidden'), 250);
  setTimeout(() => boot?.remove(), 900);
}

main();
