/**
 * The living area — a free-roaming avatar over a bounded region of the desktop.
 *
 * State is expressed in *behaviour and space*, not just a face:
 *   working   → explores the whole area
 *   idle      → pottters about slowly
 *   drowsy    → slows down, drifts to a corner
 *   sleep     → curls up and stops
 *   unknown   → mopes in one spot
 *   celebrate → a happy dash across the area
 */

import type { AvatarSnapshot } from '../../core/types.js';
import { createAvatarRenderer, type AvatarRenderer } from '../shared/renderer.js';
import { PulsePlayer } from '../shared/bridge.js';
import { driveRenderer } from '../shared/drive.js';

const AVATAR_PX = 140;

const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const area = document.getElementById('area') as HTMLDivElement;

const pulses = new PulsePlayer();
let renderer: AvatarRenderer | null = null;
let snapshot: AvatarSnapshot | null = null;

/** Position and velocity in CSS px within the living area. */
const pet = { x: 40, y: 40, vx: 26, vy: 18 };
/** Countdown of the celebratory dash, in ms. */
let dashMs = 0;

async function main(): Promise<void> {
  renderer = await createAvatarRenderer(canvas);

  window.avatar.onSnapshot(apply);
  const initial = await window.avatar.getSnapshot();
  if (initial) apply(initial);

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(64, now - last); // clamp: a backgrounded window shouldn't teleport it
    last = now;
    step(dt);
    renderer?.frame(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function apply(next: AvatarSnapshot): void {
  snapshot = next;
  if (!renderer) return;
  // Spatialize a celebration too: a happy dash across the living area.
  if (driveRenderer(renderer, next, pulses) > 0) dashMs = 1400;
}

function step(dtMs: number): void {
  const bounds = area.getBoundingClientRect();
  const maxX = Math.max(0, bounds.width - AVATAR_PX);
  const maxY = Math.max(0, bounds.height - AVATAR_PX);
  const state = snapshot?.state ?? 'unknown';

  if (dashMs > 0) dashMs = Math.max(0, dashMs - dtMs);

  // Speed is the behavioural read of state.
  let speed: number;
  switch (state) {
    case 'working':
    case 'celebrate':
      speed = 1;
      break;
    case 'idle':
      speed = 0.55;
      break;
    case 'drowsy':
      speed = 0.28;
      break;
    case 'sleep':
      speed = 0;
      break;
    case 'unknown':
      speed = 0.12; // mopes, barely moves
      break;
  }
  if (dashMs > 0) speed = Math.max(speed, 2.6);

  if (speed === 0) {
    // Sleeping: settle where it is, drifting gently to the floor of the area.
    pet.y = Math.min(maxY, pet.y + 0.02 * dtMs);
    place();
    return;
  }

  const dt = dtMs / 1000;
  pet.x += pet.vx * speed * dt;
  pet.y += pet.vy * speed * dt;

  // Bounce off the home-range edges rather than escaping them.
  if (pet.x <= 0 || pet.x >= maxX) {
    pet.vx *= -1;
    pet.x = Math.min(maxX, Math.max(0, pet.x));
  }
  if (pet.y <= 0 || pet.y >= maxY) {
    pet.vy *= -1;
    pet.y = Math.min(maxY, Math.max(0, pet.y));
  }

  // Drowsy: bias toward a corner so "drifting off" reads spatially.
  if (state === 'drowsy') {
    pet.vx += (maxX - pet.x > 0 ? 1 : -1) * 0.4;
    pet.vy += 1.2;
    pet.vx = clampAbs(pet.vx, 40);
    pet.vy = clampAbs(pet.vy, 40);
  }

  place();
}

function place(): void {
  // Face the direction of travel; the avatar is drawn facing right.
  const facing = pet.vx < 0 ? -1 : 1;
  canvas.style.transform = `translate(${pet.x.toFixed(1)}px, ${pet.y.toFixed(1)}px) scaleX(${facing})`;
}

const clampAbs = (v: number, max: number): number => Math.min(max, Math.max(-max, v));

void main();
