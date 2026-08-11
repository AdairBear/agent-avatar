#!/usr/bin/env node
/**
 * Headless proof that the core loop works — no GUI, no Electron.
 *
 * This exists because "the app launched" is not evidence that the gauges move.
 * It drives the real engine against the real fake adapter on a compressed
 * synthetic clock and asserts the behaviours that matter:
 *
 *   1. completions raise Nourishment, and each one emits exactly one celebrate pulse
 *   2. low-confidence completions are REJECTED (spec §7 rule 2)
 *   3. duplicate completion ids cannot double-feed (spec §7 rule 6)
 *   4. usage drains Stamina, and never touches Nourishment (spec §7 rule 1)
 *   5. the state ladder walks thriving → drowsy → asleep
 *   6. stale telemetry forces `unknown`, never a happy creature (spec §5.2)
 *
 * Run:  npm run smoke
 */

import { AvatarEngine } from '../dist/core/engine.mjs';
import { FakeAdapter } from '../dist/core/fake.mjs';

const CONFIG = {
  tickMs: 1_000,
  nourishmentBump: 12,
  nourishmentHalfLifeDays: 0.0006,
  hungryBelow: 35,
  acceptLikelyCompletions: false,
  drowsyBelow: 20,
  asleepAtOrBelow: 0,
  livenessWindowS: 45,
};

// A synthetic clock: no sleeping, no flakiness, and the whole arc in milliseconds.
let clock = Date.parse('2026-08-11T12:00:00Z');
const now = () => clock;

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
};

async function main() {
  const adapter = new FakeAdapter({
    drainSeconds: 120,
    completionEverySeconds: 8,
    now,
  });

  const engine = new AvatarEngine({
    adapters: [adapter],
    config: CONFIG,
    now,
    log: () => {},
  });

  const seenPulseIds = new Set();
  let duplicatePulses = 0;
  const timeline = [];

  engine.onSnapshot((snapshot) => {
    for (const pulse of snapshot.pulses) {
      if (seenPulseIds.has(pulse.id)) duplicatePulses += 1;
      seenPulseIds.add(pulse.id);
    }
    timeline.push(snapshot);
  });

  console.log('\nDriving the engine for 130 synthetic seconds…\n');
  await engine.start();
  for (let i = 0; i < 130; i++) {
    clock += 1_000;
    await engine.tick();
  }
  await engine.stop();

  const states = new Set(timeline.map((s) => s.state));
  const maxNourishment = Math.max(...timeline.map((s) => s.nourishment));
  const first = timeline[0];
  const last = timeline[timeline.length - 1];

  console.log('Assertions:');

  check('nourishment rose above zero from completions', maxNourishment > 0, `max=${maxNourishment}`);
  check('celebrate pulses were emitted', seenPulseIds.size > 0, `${seenPulseIds.size} pulses`);
  check('no pulse id was ever emitted twice', duplicatePulses === 0, `${duplicatePulses} dupes`);

  // The fake adapter marks every 4th completion `guessing`, and re-returns an
  // overlapping window every poll. Accepted count must equal only the confident,
  // deduped ones.
  const issued = Math.floor(130 / 8);
  const expectedAccepted = issued - Math.floor(issued / 4);
  check(
    'only confident, deduplicated completions were accepted',
    last.completionsAccepted === expectedAccepted,
    `accepted=${last.completionsAccepted} expected=${expectedAccepted} issued=${issued}`,
  );
  check(
    'accepted count equals celebrate pulse count (one pulse per accepted completion)',
    last.completionsAccepted === seenPulseIds.size,
    `${last.completionsAccepted} vs ${seenPulseIds.size}`,
  );

  check('stamina drained to zero', last.stamina === 0, `final=${last.stamina}`);
  check('stamina started healthy', first.stamina > 90, `initial=${first.stamina}`);
  check('state reached asleep', states.has('asleep'));
  check('state passed through drowsy', states.has('drowsy'));
  check('state was thriving at some point', states.has('thriving'));

  // Spec §7 rule 1: burning budget must be structurally unable to feed the creature.
  const staminaZero = timeline.filter((s) => s.stamina === 0);
  check(
    'nourishment is independent of usage (creature can be asleep AND fed)',
    staminaZero.some((s) => s.nourishment > 0),
    'expected at least one asleep-but-nourished snapshot',
  );

  const droopingSeen = timeline.some((s) => s.drooping.length > 0);
  check('a stale workstream drooped a limb', droopingSeen);
  check(
    'drooping is additive, not a whole-body state',
    timeline.some((s) => s.drooping.length > 0 && s.state !== 'unknown'),
  );

  // Freshness invariant: a source that cannot prove freshness must never render healthy.
  const staleAdapter = {
    id: 'stale',
    label: 'deliberately stale source',
    async usage() {
      return {
        type: 'usage',
        window: 'stale-window',
        used: 0, // would otherwise read as a FULL tank
        unit: 'ratio_of_plan',
        resetsAt: new Date(clock + 3600_000).toISOString(),
        freshAt: new Date(clock - 3600_000).toISOString(), // an hour old
        staleAfterS: 30,
        source: 'stale',
      };
    },
  };
  const staleEngine = new AvatarEngine({ adapters: [staleAdapter], config: CONFIG, now, log: () => {} });
  const staleSnapshot = await staleEngine.tick();
  check(
    'stale telemetry yields `unknown`, not a full-stamina happy creature',
    staleSnapshot.state === 'unknown' && staleSnapshot.fresh === false,
    `state=${staleSnapshot.state} fresh=${staleSnapshot.fresh}`,
  );

  // And the no-source case, which must behave the same way rather than showing zero.
  const emptyEngine = new AvatarEngine({ adapters: [], config: CONFIG, now, log: () => {} });
  const emptySnapshot = await emptyEngine.tick();
  check(
    'no usage source at all also yields `unknown` (no fake zeros)',
    emptySnapshot.state === 'unknown',
    `state=${emptySnapshot.state}`,
  );

  console.log('\nSample timeline (every 15s):');
  console.log('   t   nourish  stamina  state      drooping');
  for (let i = 0; i < timeline.length; i += 15) {
    const s = timeline[i];
    console.log(
      `  ${String(i).padStart(3)}  ${String(s.nourishment).padStart(6)}  ${String(s.stamina).padStart(7)}  ` +
        `${s.state.padEnd(9)}  ${s.drooping.join(',') || '—'}`,
    );
  }

  if (failures.length > 0) {
    console.log(`\nFAILED — ${failures.length} assertion(s): ${failures.join('; ')}\n`);
    process.exit(1);
  }
  console.log('\nAll assertions passed.\n');
}

main().catch((error) => {
  console.error('smoke test threw:', error);
  process.exit(1);
});
