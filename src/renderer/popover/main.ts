/**
 * The popover: click the menu-bar den to see the three gauges and what's in flight.
 */

import type { AvatarSnapshot } from '../../core/types.js';
import { createAvatarRenderer, type AvatarRenderer } from '../shared/renderer.js';
import { PulsePlayer } from '../shared/bridge.js';
import { driveRenderer } from '../shared/drive.js';

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
  energyValue: el('energy-value'),
  energyBar: el('energy-bar'),
  energyHint: el('energy-hint'),
  healthValue: el('health-value'),
  healthBar: el('health-bar'),
  healthHint: el('health-hint'),
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
  ui.stateCopy.textContent = snapshot.stateText;

  // A stale snapshot shows `?`, never a number it cannot back up.
  setGauge(ui.nourishmentValue, ui.nourishmentBar, snapshot.nourishment, snapshot.fresh);
  setGauge(ui.energyValue, ui.energyBar, snapshot.energy, snapshot.fresh);
  setGauge(ui.healthValue, ui.healthBar, snapshot.health, snapshot.fresh);

  ui.energyHint.textContent = snapshot.fresh
    ? energyHint(snapshot)
    : 'Telemetry is stale — not going to show you a number it cannot back up.';
  ui.healthHint.textContent = snapshot.fresh
    ? `${snapshot.healthDetail.liveWorkstreams} of ${snapshot.healthDetail.knownWorkstreams} workstreams live`
    : 'Unknown.';

  if (renderer) driveRenderer(renderer, snapshot, pulses);

  renderWorkstreams(snapshot);

  ui.provenance.textContent = [
    `${snapshot.nourishmentDetail.acceptedCompletions} completions`,
    snapshot.mode === 'mock' ? 'MOCK DATA' : 'local logs',
    renderer ? [renderer.kind, renderer.detail].filter(Boolean).join(' ') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function setGauge(
  valueEl: HTMLElement,
  barEl: HTMLElement,
  value: number,
  fresh: boolean,
): void {
  valueEl.textContent = fresh ? `${Math.round(value)}` : '?';
  barEl.style.width = `${fresh ? value : 100}%`;
}

function energyHint(snapshot: AvatarSnapshot): string {
  const { usedRatio, windowHours, recoversAt } = snapshot.energyDetail;
  const used = `${Math.round(usedRatio * 100)}% of a ${windowHours}h budget used`;
  if (snapshot.state === 'sleep' && recoversAt) {
    return `${used} · wakes ${formatClock(recoversAt)}`;
  }
  return used;
}

function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'later';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
