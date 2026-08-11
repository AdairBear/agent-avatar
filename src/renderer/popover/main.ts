/**
 * The popover: click the menu-bar den to see the two gauges and what's in flight.
 */

import type { AvatarSnapshot } from '../../core/types.js';
import { describeState } from '../../core/state.js';
import { createAvatarRenderer, type AvatarRenderer } from '../shared/renderer.js';
import { PulsePlayer } from '../shared/bridge.js';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const ui = {
  canvas: el<HTMLCanvasElement>('avatar'),
  stateName: el('state-name'),
  stateCopy: el('state-copy'),
  nourishmentValue: el('nourishment-value'),
  nourishmentBar: el('nourishment-bar'),
  staminaValue: el('stamina-value'),
  staminaBar: el('stamina-bar'),
  staminaHint: el('stamina-hint'),
  workstreamList: el<HTMLUListElement>('workstream-list'),
  provenance: el('provenance'),
  toggleLiving: el<HTMLButtonElement>('toggle-living'),
  quit: el<HTMLButtonElement>('quit'),
};

const pulses = new PulsePlayer();
let renderer: AvatarRenderer | null = null;

async function main(): Promise<void> {
  renderer = await createAvatarRenderer(ui.canvas);

  let last = performance.now();
  const loop = (now: number) => {
    renderer?.frame(now - last);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  window.avatar.onSnapshot(render);
  const initial = await window.avatar.getSnapshot();
  if (initial) render(initial);

  ui.toggleLiving.addEventListener('click', () => void window.avatar.toggleLivingArea());
  ui.quit.addEventListener('click', () => void window.avatar.quit());
}

function render(snapshot: AvatarSnapshot): void {
  document.body.classList.toggle('is-stale', !snapshot.fresh);

  ui.stateName.textContent = snapshot.state;
  ui.stateCopy.textContent = describeState(snapshot.state);

  ui.nourishmentValue.textContent = `${Math.round(snapshot.nourishment)}`;
  ui.nourishmentBar.style.width = `${snapshot.nourishment}%`;
  ui.staminaValue.textContent = snapshot.fresh ? `${Math.round(snapshot.stamina)}` : '?';
  ui.staminaBar.style.width = `${snapshot.fresh ? snapshot.stamina : 100}%`;

  ui.staminaHint.textContent = snapshot.fresh
    ? staminaHint(snapshot)
    : 'Telemetry is stale — not going to show you a number it cannot back up.';

  renderer?.setNourishment(snapshot.nourishment / 100);
  renderer?.setStamina(snapshot.stamina / 100);
  renderer?.setStateName(snapshot.state);
  for (const _pulse of pulses.take(snapshot.pulses)) renderer?.celebrate();

  renderWorkstreams(snapshot);

  ui.provenance.textContent = [
    `${snapshot.completionsAccepted} completions`,
    snapshot.usage ? `via ${snapshot.usage.source}` : 'no usage source',
    renderer ? renderer.kind : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function staminaHint(snapshot: AvatarSnapshot): string {
  if (!snapshot.usage) return 'Drained by usage budget.';
  const cost = snapshot.usage.costUsd != null ? ` · $${snapshot.usage.costUsd.toFixed(2)}` : '';
  return `${Math.round(snapshot.usage.used * 100)}% of budget used${cost}`;
}

function renderWorkstreams(snapshot: AvatarSnapshot): void {
  ui.workstreamList.replaceChildren(
    ...snapshot.workstreams.map((w) => {
      const li = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = w.live ? 'dot' : 'dot stale';
      li.append(dot);

      const label = document.createElement('span');
      label.textContent = w.label;
      li.append(label);

      const age = document.createElement('span');
      age.className = 'age';
      age.textContent = w.live ? 'live' : `quiet ${formatAge(w.ageS)}`;
      li.append(age);

      return li;
    }),
  );

  if (snapshot.workstreams.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing detected yet.';
    ui.workstreamList.append(li);
  }
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

void main();
