/**
 * The menu-bar den (spec §10.3).
 *
 * Phase 1 renders the den as a *title string* rather than an icon:
 * `🦫 N▓▓▓░░ S▓▓▓▓░`. That is a deliberate scaffolding choice — it ships zero
 * image assets, it is legible at a glance, and it means both gauges are visible
 * without opening anything.
 *
 * Track 1 replaces this with a template PNG (or a small offscreen Rive render)
 * once the art exists; `update()` is the only function that changes.
 */

import { Menu, Tray, nativeImage } from 'electron';
import type { AvatarSnapshot, AvatarStateName } from '../core/types.js';

const STATE_GLYPH: Record<AvatarStateName, string> = {
  thriving: '🦫',
  hungry: '🦫',
  drowsy: '🥱',
  asleep: '💤',
  unknown: '❔',
};

const BAR_SEGMENTS = 5;

export interface TrayCallbacks {
  onClick(bounds: Electron.Rectangle): void;
  onToggleLivingArea(): void;
  onQuit(): void;
}

export class AvatarTray {
  private readonly tray: Tray;

  constructor(private readonly callbacks: TrayCallbacks) {
    // An empty image + a title is the supported way to run a text-only macOS
    // menu-bar item.
    this.tray = new Tray(nativeImage.createEmpty());
    this.tray.setTitle('🦫 …');
    this.tray.setToolTip('Agentic Avatar');

    this.tray.on('click', (_event, bounds) => this.callbacks.onClick(bounds));
    this.tray.on('right-click', () => this.tray.popUpContextMenu(this.buildMenu()));
  }

  update(snapshot: AvatarSnapshot): void {
    const glyph = STATE_GLYPH[snapshot.state];

    if (!snapshot.fresh) {
      this.tray.setTitle(`${glyph} —`);
      this.tray.setToolTip('Agentic Avatar — telemetry stale');
      return;
    }

    const n = bar(snapshot.nourishment);
    const s = bar(snapshot.stamina);
    this.tray.setTitle(`${glyph} ${n} ${s}`);

    const drooping = snapshot.drooping.length;
    this.tray.setToolTip(
      [
        `Agentic Avatar — ${snapshot.state}`,
        `Nourishment ${Math.round(snapshot.nourishment)} · Stamina ${Math.round(snapshot.stamina)}`,
        drooping > 0 ? `${drooping} workstream${drooping === 1 ? '' : 's'} quiet` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  private buildMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: 'Show stats', click: () => this.callbacks.onClick(this.tray.getBounds()) },
      { label: 'Toggle living area', click: () => this.callbacks.onToggleLivingArea() },
      { type: 'separator' },
      { label: 'Quit Agentic Avatar', click: () => this.callbacks.onQuit() },
    ]);
  }

  destroy(): void {
    this.tray.destroy();
  }
}

/** `▓▓▓░░` — a 5-segment bar that reads at menu-bar size. */
function bar(value0to100: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, value0to100)) / 100) * BAR_SEGMENTS);
  return '▓'.repeat(filled) + '░'.repeat(BAR_SEGMENTS - filled);
}
