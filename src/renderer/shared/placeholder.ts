/**
 * Placeholder avatar — a canvas-2D blob.
 *
 * Deliberately crude. Its only job is to prove the signal path end to end: you
 * should be able to watch nourishment and energy move and see the creature
 * respond, before a single frame of Rive art exists.
 *
 * It reads exactly the four signals the `.riv` will read, through exactly the
 * same interface, so replacing it changes nothing upstream.
 */

import type { AvatarRenderer } from './renderer.js';
import type { AvatarStateName } from '../../core/types.js';

export class PlaceholderAvatarRenderer implements AvatarRenderer {
  readonly kind = 'placeholder' as const;

  private nourishment = 0.5;
  private energy = 1;
  private working = false;
  private state: AvatarStateName = 'unknown';

  /** Seconds since construction — drives idle bob and blink. */
  private t = 0;
  /** Countdown of the celebrate hop, in ms. */
  private hopMs = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setNourishment(value01: number): void {
    this.nourishment = clamp01(value01);
  }

  setEnergy(value01: number): void {
    this.energy = clamp01(value01);
  }

  setWorking(working: boolean): void {
    this.working = working;
  }

  setStateName(state: AvatarStateName): void {
    this.state = state;
  }

  celebrate(): void {
    this.hopMs = 900;
  }

  frame(dtMs: number): void {
    this.t += dtMs / 1000;
    if (this.hopMs > 0) this.hopMs = Math.max(0, this.hopMs - dtMs);
    this.draw();
  }

  destroy(): void {}

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 160;
    const cssH = this.canvas.clientHeight || 160;
    if (this.canvas.width !== cssW * dpr || this.canvas.height !== cssH * dpr) {
      this.canvas.width = cssW * dpr;
      this.canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const asleep = this.state === 'sleep';
    const unknown = this.state === 'unknown';

    // Plumpness tracks nourishment; saturation and eyelids track energy.
    const plump = 0.72 + this.nourishment * 0.28;
    const saturation = unknown ? 0 : 28 + this.energy * 42;
    const lightness = unknown ? 62 : 52 + this.nourishment * 10;
    const hue = 24 + this.nourishment * 14; // warm, muted — spec §8 art direction

    // Idle bob, plus the celebrate hop.
    const workBoost = this.working ? 1.7 : 1;
    const idleBob = asleep ? 0 : Math.sin(this.t * (1.2 + this.energy * 1.6) * workBoost) * 3;
    const hopProgress = this.hopMs > 0 ? this.hopMs / 900 : 0;
    const hop = Math.sin(hopProgress * Math.PI) * 26;

    const cx = cssW / 2;
    const cy = cssH / 2 + (asleep ? 16 : 0) + idleBob - hop;
    const bodyR = Math.min(cssW, cssH) * 0.3 * plump;

    // Ground shadow — tightens as the creature hops, which sells the motion.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cx, cssH * 0.78, bodyR * (0.9 - hop / 120), bodyR * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Body.
    ctx.fillStyle = `hsl(${hue} ${saturation}% ${lightness}%)`;
    ctx.beginPath();
    if (asleep) {
      ctx.ellipse(cx, cy, bodyR * 1.25, bodyR * 0.78, 0, 0, Math.PI * 2);
    } else {
      ctx.ellipse(cx, cy, bodyR, bodyR * 0.92, 0, 0, Math.PI * 2);
    }
    ctx.fill();

    // Ears — two small nubs, enough to read as a creature rather than a ball.
    if (!asleep) {
      ctx.beginPath();
      ctx.ellipse(cx - bodyR * 0.62, cy - bodyR * 0.66, bodyR * 0.2, bodyR * 0.22, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + bodyR * 0.62, cy - bodyR * 0.66, bodyR * 0.2, bodyR * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawFace(ctx, cx, cy, bodyR, asleep, unknown);
  }

  private drawFace(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    bodyR: number,
    asleep: boolean,
    unknown: boolean,
  ): void {
    const eyeDx = bodyR * 0.34;
    const eyeY = cy - bodyR * 0.1;
    const eyeR = bodyR * 0.11;

    ctx.fillStyle = '#2b2118';
    ctx.strokeStyle = '#2b2118';
    ctx.lineWidth = Math.max(1.6, bodyR * 0.055);
    ctx.lineCap = 'round';

    if (asleep) {
      // Closed, contented arcs.
      for (const dx of [-eyeDx, eyeDx]) {
        ctx.beginPath();
        ctx.arc(cx + dx, eyeY, eyeR * 1.3, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
      this.drawZs(ctx, cx + bodyR * 1.1, cy - bodyR * 0.9, bodyR);
      return;
    }

    // Blink, plus energy-driven eyelid droop.
    const blinking = Math.sin(this.t * 0.8) > 0.985;
    const droop = 1 - this.energy; // 0 wide awake → 1 heavy lids
    const openness = blinking ? 0.05 : Math.max(0.18, 1 - droop * 0.75);

    for (const dx of [-eyeDx, eyeDx]) {
      ctx.beginPath();
      ctx.ellipse(cx + dx, eyeY, eyeR, eyeR * openness, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Mouth: a small smile when well fed, a flat line when hungry.
    const smile = this.nourishment;
    ctx.beginPath();
    ctx.moveTo(cx - bodyR * 0.16, cy + bodyR * 0.3);
    ctx.quadraticCurveTo(cx, cy + bodyR * (0.3 + smile * 0.22), cx + bodyR * 0.16, cy + bodyR * 0.3);
    ctx.stroke();

    if (unknown) {
      ctx.font = `600 ${bodyR * 0.7}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('?', cx + bodyR * 1.25, cy - bodyR * 0.4);
    }
  }

  private drawZs(ctx: CanvasRenderingContext2D, x: number, y: number, bodyR: number): void {
    ctx.font = `600 ${bodyR * 0.42}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      const phase = (this.t * 0.5 + i * 0.33) % 1;
      ctx.globalAlpha = 0.7 * (1 - phase);
      ctx.fillText('z', x + phase * bodyR * 0.5, y - phase * bodyR * 0.9);
    }
    ctx.globalAlpha = 1;
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
