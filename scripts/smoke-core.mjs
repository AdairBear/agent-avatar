#!/usr/bin/env node
/**
 * Headless proof that the desktop core works — no GUI, no Electron, no backend.
 *
 * This exists because "the app launched" is not evidence that the gauges move.
 * It drives the real client and the real mock source and asserts the
 * behaviours that matter:
 *
 *   1. a real backend payload parses into a snapshot with the right gauges
 *   2. the four Rive input names survive the round trip
 *   3. an unreachable backend renders `unknown`, never a healthy creature
 *   4. a payload older than its own staleness budget is downgraded to `unknown`
 *   5. malformed JSON and junk payloads degrade instead of throwing
 *   6. mock mode walks the arc and reaches `sleep`
 *
 * Run:  npm run smoke
 */

import { TelemetryClient, normalize } from '../dist/core/client.mjs';
import { MockSource } from '../dist/core/mock.mjs';

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label} ${detail}`);
    failures.push(label);
  }
};

/** A payload shaped exactly like `avatar_telemetry` publishes. */
function backendPayload(overrides = {}) {
  return {
    schema: 'agentic-avatar.telemetry/1',
    at: new Date().toISOString(),
    mode: 'live',
    fresh: true,
    stale_after_seconds: 180,
    state: 'working',
    state_text: 'Busy — something is moving.',
    gauges: { nourishment: 42.5, energy: 77.5, health: 66.7 },
    rive_inputs: { nourishment: 42.5, energy: 77.5, isWorking: true, celebrate: [] },
    nourishment_detail: {
      accepted_completions: 4,
      rejected_completions: 9,
      accept_confidence: 'certain',
    },
    energy_detail: {
      used_ratio: 0.225,
      weighted_tokens: 10_125_000,
      budget_tokens: 45_000_000,
      window_hours: 5,
      recovers_at: null,
    },
    health_detail: { live_workstreams: 2, known_workstreams: 5, healthy_at: 3 },
    workstreams: [
      {
        id: 'trident-forge',
        label: 'Trident Forge',
        live: true,
        last_meaningful_at: new Date().toISOString(),
        age_seconds: 12,
      },
    ],
    drooping: ['ebooklm'],
    pulses: [{ id: 'celebrate:commit:x:abc1234', kind: 'celebrate', at: '', label: 'x' }],
    recent_completions: [],
    ...overrides,
  };
}

/** A transport that serves a canned body, or nothing at all. */
const transportOf = (body) => ({
  fetchState: async () => body,
  readStateFile: async () => null,
});

const clientWith = (body, now) =>
  new TelemetryClient({
    url: 'http://127.0.0.1:8787/state',
    stateFile: '/nonexistent/state.json',
    transport: transportOf(body),
    now,
    log: () => {},
  });

console.log('\n1. A real backend payload parses');
{
  const snapshot = normalize(backendPayload());
  check('nourishment maps through', snapshot.nourishment === 42.5);
  check('energy maps through', snapshot.energy === 77.5);
  check('health maps through', snapshot.health === 66.7);
  check('state maps through', snapshot.state === 'working');
  check('isWorking maps through', snapshot.isWorking === true);
  check('mode maps through', snapshot.mode === 'live');
  check('workstreams map through', snapshot.workstreams[0]?.id === 'trident-forge');
  check('pulses map through', snapshot.pulses.length === 1);
  check('drooping maps through', snapshot.drooping[0] === 'ebooklm');
  check(
    'energy provenance maps through',
    snapshot.energyDetail.budgetTokens === 45_000_000 && snapshot.energyDetail.windowHours === 5,
  );
  check(
    'completion counts map through',
    snapshot.nourishmentDetail.acceptedCompletions === 4 &&
      snapshot.nourishmentDetail.rejectedCompletions === 9,
  );
}

console.log('\n2. Gauges stay inside 0–100');
{
  const wild = normalize(backendPayload({ gauges: { nourishment: 999, energy: -50, health: 12 } }));
  check('over-range clamps to 100', wild.nourishment === 100);
  check('under-range clamps to 0', wild.energy === 0);
}

console.log('\n3. An unreachable backend is never a healthy creature');
{
  const snapshot = await clientWith(null).poll();
  check('state is unknown', snapshot.state === 'unknown');
  check('fresh is false', snapshot.fresh === false);
  check('gauges are not invented', snapshot.nourishment === 0 && snapshot.energy === 0);
}

console.log('\n4. A stale payload is downgraded, not trusted');
{
  const old = backendPayload({ at: new Date(Date.now() - 3_600_000).toISOString() });
  const snapshot = await clientWith(JSON.stringify(old)).poll();
  check('an hour-old snapshot reads unknown', snapshot.state === 'unknown');
  check('and is marked not fresh', snapshot.fresh === false);

  const recent = await clientWith(JSON.stringify(backendPayload())).poll();
  check('a fresh snapshot is kept', recent.state === 'working' && recent.fresh === true);
}

console.log('\n5. Junk degrades instead of throwing');
{
  check('malformed JSON → unknown', (await clientWith('{not json').poll()).state === 'unknown');
  check('empty object → unknown', (await clientWith('{}').poll()).state === 'unknown');
  check('array payload → unknown', (await clientWith('[]').poll()).state === 'unknown');
  check('null gauges → unknown', normalize({ gauges: null }) === null);
  const bogusState = normalize(backendPayload({ state: 'ecstatic' }));
  check('an unrecognised state falls back to unknown', bogusState.state === 'unknown');
}

console.log('\n6. Late subscribers get the current snapshot');
{
  const client = clientWith(JSON.stringify(backendPayload()));
  await client.poll();
  let received = null;
  client.onSnapshot((s) => (received = s));
  check('subscribing after a poll delivers immediately', received?.state === 'working');
}

console.log('\n7. Mock mode walks the arc');
{
  let clock = Date.parse('2026-08-18T12:00:00Z');
  const source = new MockSource({ now: () => clock });

  const start = source.snapshot();
  check('starts with full energy', start.energy === 100);
  check('starts working', start.state === 'working');
  check('mode is mock', start.mode === 'mock');
  check('is always fresh', start.fresh === true);

  clock += 25_000;
  const celebrating = source.snapshot();
  check('a completion fires a celebrate pulse', celebrating.pulses.length >= 1);
  check('and enters celebrate', celebrating.state === 'celebrate');

  clock += 160_000;
  const drained = source.snapshot();
  check('energy drains to zero', drained.energy === 0);
  check('and the creature sleeps', drained.state === 'sleep');

  clock += 600_000;
  const held = source.snapshot();
  check('sleep holds rather than wrapping', held.state === 'sleep' && held.energy === 0);
  check('pulses stay bounded', held.pulses.length <= 8);

  const pinned = new MockSource({ now: () => clock, pinned: { energy: 15, nourishment: 80 } });
  const posed = pinned.snapshot();
  check('pinned values hold (the slider path)', posed.energy === 15 && posed.nourishment === 80);
  check('and resolve to drowsy', posed.state === 'drowsy');
}

console.log('\n8. Mock snapshots satisfy the same contract as live ones');
{
  const source = new MockSource();
  const snapshot = source.snapshot();
  for (const key of ['nourishment', 'energy', 'health', 'state', 'isWorking', 'fresh', 'pulses']) {
    check(`mock snapshot has ${key}`, key in snapshot);
  }
  check(
    'mock gauges are in range',
    [snapshot.nourishment, snapshot.energy, snapshot.health].every((v) => v >= 0 && v <= 100),
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`FAILED — ${failures.length} check(s):\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
console.log('All core checks passed.\n');
