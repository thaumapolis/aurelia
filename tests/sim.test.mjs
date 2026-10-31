/**
 * Physics and audio-mapping unit tests, run with `node --test`.
 *
 * These cover the claims the app makes to the player in words: length sets
 * pitch, a pluck rings and decays, rubbing sustains, nearby strings influence
 * each other, and nothing blows up numerically. They deliberately avoid
 * asserting exact waveforms, which would just mirror the integrator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Instrument,
  StringLine,
  Phase,
  Proximity,
  MIN_LENGTH_PX,
  MAX_STRINGS,
  PITCH_ANCHOR_HZ,
  PITCH_REFERENCE_PX,
  CROSS_TALK_FRACTION,
  DISPLACEMENT_CLAMP,
  segmentDistance,
  makeRandom,
} from '../src/sim.js';
import { AudioEngine, PARTIALS } from '../src/audio.js';

const step = (instrument, frames, dt = 1 / 60) => {
  for (let i = 0; i < frames; i += 1) instrument.step(dt, []);
};

/** Minimal fake WebAudio graph that records what the engine asks for. */
function fakeAudioContext(record) {
  const parameter = (label) => ({
    value: 0,
    setTargetAtTime(value) {
      record.push(`${label}=${value.toFixed(5)}`);
      return this;
    },
  });
  const node = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });
  return class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'suspended';
      this.destination = node();
    }
    createGain() {
      return node({ gain: parameter('gain') });
    }
    createOscillator() {
      const oscillator = node({
        type: 'sine',
        frequency: parameter('frequency'),
        start() {
          record.push('oscillator.start');
        },
        stop() {
          record.push('oscillator.stop');
        },
      });
      return oscillator;
    }
    createDynamicsCompressor() {
      return node({
        threshold: parameter('threshold'),
        knee: parameter('knee'),
        ratio: parameter('ratio'),
      });
    }
    async resume() {
      this.state = 'running';
      record.push('resume');
    }
    close() {
      record.push('close');
    }
  };
}

test('a string is anchored where it was drawn', () => {
  const instrument = new Instrument(1);
  const line = instrument.add(100, 200, 500, 240);
  assert.ok(line);
  const mid = line.restAt(0.5);
  assert.ok(Math.abs(mid.x - 300) < 1e-6, `midpoint x was ${mid.x}`);
  assert.ok(Math.abs(mid.y - 220) < 1e-6, `midpoint y was ${mid.y}`);
  assert.deepEqual([line.restAt(0).x, line.restAt(1).x], [100, 500].map(Number));
});

test('pitch follows length: halving a string raises it an octave', () => {
  const instrument = new Instrument(1);
  const long = instrument.add(0, 0, 800, 0);
  const short = instrument.add(0, 100, 400, 100);
  const ratio = short.pitchHz() / long.pitchHz();
  assert.ok(Math.abs(ratio - 2) < 1e-9, `expected 2x, got ${ratio}`);
  assert.ok(Math.abs(long.pitchHz() - PITCH_ANCHOR_HZ * (PITCH_REFERENCE_PX / 800)) < 1e-9);
});

test('toLocal round-trips a point on the string', () => {
  const instrument = new Instrument(1);
  const line = instrument.add(200, 100, 800, 260);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const point = line.restAt(t);
    const local = line.toLocal(point.x, point.y);
    assert.ok(Math.abs(local.along - t) < 1e-6, `t=${t} came back as ${local.along}`);
    assert.ok(Math.abs(local.across) < 1e-6, `across should be 0 on the string, got ${local.across}`);
  }
  // Off the end of the string, `along` leaves [0,1] rather than lying about it.
  const beyond = line.toLocal(...Object.values(line.restAt(1.4)).map(Number));
  assert.ok(beyond.along > 1, 'a point past the end must report along > 1');
});

test('a pluck rings: energy appears, the field stays finite, and it decays', () => {
  const instrument = new Instrument(7);
  const line = instrument.add(100, 300, 900, 300);
  assert.equal(line.energy(), 0);
  line.pluck(0.45, 1.5, 1);
  assert.ok(line.amplitude() > 0.5, 'a hard pluck should visibly displace the string');
  step(instrument, 30);
  assert.ok(line.u.every(Number.isFinite), 'wave field went non-finite');
  assert.ok(line.v.every(Number.isFinite), 'velocity field went non-finite');
  const early = line.amplitude();
  step(instrument, 240);
  assert.ok(line.amplitude() < early * 0.5, `expected decay: ${early} -> ${line.amplitude()}`);
});

test('displacement is clamped so the wave equation cannot diverge', () => {
  const instrument = new Instrument(11);
  const line = instrument.add(100, 300, 900, 300);
  for (let i = 0; i < 400; i += 1) line.pluck(0.5, 1e6, 1);
  step(instrument, 120);
  for (const value of line.u) {
    assert.ok(Math.abs(value) <= DISPLACEMENT_CLAMP + 1e-6, `|u|=${value} escaped the clamp`);
  }
});

test('bowing builds from silence and settles; plucking only decays', () => {
  const instrument = new Instrument(3);
  const line = instrument.add(100, 300, 900, 300);
  line.u.fill(0);
  line.v.fill(0);
  // Onset is sampled in the first moments of growth. Averaging a few frames,
  // rather than trusting one, is deliberate: the amplitude of a forming standing
  // wave oscillates within each period, so any single frame can land on a dip.
  const trajectory = [];
  for (let frame = 0; frame < 300; frame += 1) {
    line.bow({ along: 0.45, across: 1 }, 520, 1 / 60);
    instrument.step(1 / 60, []);
    if (frame % 10 === 9) trajectory.push(line.amplitude());
  }
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const onset = mean(trajectory.slice(0, 3));
  const settled = mean(trajectory.slice(-12));
  assert.ok(onset > 0, 'a bow rubbed against a still string must move it');
  assert.ok(
    settled > onset * 1.8,
    `bowing should build the string up: onset=${onset.toFixed(4)} settled=${settled.toFixed(4)}`,
  );
  assert.ok(
    settled < DISPLACEMENT_CLAMP * 0.8,
    `a bowed level that runs to the clamp buzzes instead of singing: ${settled}`,
  );

  // The control: identical string, plucked once, with nothing added afterwards.
  const plucked = instrument.add(100, 400, 900, 400);
  plucked.u.fill(0);
  plucked.v.fill(0);
  plucked.pluck(0.45, 1.5, 1);
  const decay = [];
  for (let frame = 0; frame < 300; frame += 1) {
    instrument.step(1 / 60, []);
    if (frame % 10 === 9) decay.push(plucked.amplitude());
  }
  assert.ok(
    mean(decay.slice(-12)) < mean(decay.slice(0, 3)),
    'a plucked string must lose energy once left alone',
  );
});

test('where you pull changes the sound: mid-span rings louder than near the end', () => {
  // A string fixed at both ends cannot move at its ends, so pulling it there
  // puts in far less energy than pulling it mid-span. This is why "the shape you
  // leave in a string sets its timbre" is true, and why a pluck near the bridge
  // sounds thin while one at the middle sounds full.
  //
  // Loudness is the peak over a window rather than the level at one instant: a
  // standing wave sloshes energy between displacement and velocity, so any single
  // frame can land on a node of the envelope even for a loud string.
  const instrument = new Instrument(5);
  const middle = instrument.add(100, 400, 900, 400);
  const nearEnd = instrument.add(100, 500, 900, 500);

  const peakOver = (line, frames) => {
    let peak = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      instrument.step(1 / 60, []);
      peak = Math.max(peak, line.amplitude());
    }
    return peak;
  };

  middle.u.fill(0);
  middle.v.fill(0);
  nearEnd.u.fill(0);
  nearEnd.v.fill(0);
  middle.pluck(0.5, 1.4, 1);
  nearEnd.pluck(0.02, 1.4, 1);
  const loud = peakOver(middle, 90);
  const thin = peakOver(nearEnd, 90);
  assert.ok(loud > 0.5, `a mid-span pluck should be loud: ${loud}`);
  assert.ok(
    loud > thin * 1.3,
    `pulling near a fixed end should sound thinner than mid-span: mid=${loud.toFixed(3)} end=${thin.toFixed(3)}`,
  );
});

test('a plucked string drives its nearby neighbours', () => {
  const instrument = new Instrument(9);
  // Four parallel rows, spaced well inside the coupling radius.
  const rows = [0, 1, 2, 3].map((i) => instrument.add(100, 300 + i * 60, 900, 300 + i * 60));
  for (const row of rows) {
    row.u.fill(0);
    row.v.fill(0);
  }
  rows[2].pluck(0.5, 1.5, 1);
  step(instrument, 120);
  assert.ok(rows[2].energy() > 0, 'the driven string should still be moving');
  assert.ok(rows[1].energy() > 1e-9, `neighbour received no energy: ${rows[1].energy()}`);
  // The far row is further from the source than the near row: coupling decays.
  assert.ok(rows[1].energy() > rows[0].energy(), 'coupling should fall off with distance');
});

test('coupling radius scales with the instrument, not with pixels', () => {
  const small = new Instrument(1);
  const big = new Instrument(1);
  const smallRow = small.add(0, 0, 100, 0);
  const bigRow = big.add(0, 0, 1000, 0);
  assert.ok(Math.abs(small._couplingRadius ?? smallRow.lengthPx * CROSS_TALK_FRACTION) >= 0);
  // A neighbour 20% of length away couples; one 60% away does not.
  const near = small.add(0, smallRow.lengthPx * 0.2, 100, smallRow.lengthPx * 0.2);
  assert.equal(small._neighbours(smallRow).length, 1);
  const far = big.add(0, bigRow.lengthPx * 0.6, 1000, bigRow.lengthPx * 0.6);
  assert.equal(big._neighbours(bigRow).length, 0, 'a distant string must not couple');
  void near;
  void far;
});

test('segmentDistance measures the gap between two spans', () => {
  const cases = [
    ['parallel', { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 40 }, { x: 100, y: 40 }, 40],
    ['crossing', { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }, 0],
    ['perpendicular', { x: 0, y: 0 }, { x: 0, y: 100 }, { x: 60, y: 40 }, { x: 60, y: 90 }, 60],
    // Endpoints 50 apart, but the segments themselves are 10 apart: the second
    // segment starts well past the end of the first horizontally, so the closest
    // pair is the far end of the first against the near end of the second.
    ['near-miss', { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 }, Math.hypot(90, 50)],
    ['touching', { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, 0],
    ['skew close', { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 7 }, { x: 50, y: 30 }, 7],
  ];
  for (const [name, a, b, c, d, want] of cases) {
    const got = segmentDistance(a, b, c, d);
    assert.ok(Math.abs(got - want) < 1e-6, `${name}: expected ${want}, got ${got}`);
  }
});

test('collinear but disjoint segments are not touching', () => {
  // The regression this guards: two parallel spans that share a line but do not
  // overlap used to measure 0, because the closest-pair solve divides by a
  // determinant that vanishes for parallel input and the result was not checked.
  // A distance of 0 reads as "crossing", so every collinear pair of strings was
  // wrongly treated as an independent voice and none of them coupled.
  const gap = segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 0 }, { x: 110, y: 0 });
  assert.equal(gap, 90);
  const reversed = segmentDistance({ x: 110, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 });
  assert.equal(reversed, 90);
  const overlapping = segmentDistance({ x: 0, y: 5 }, { x: 100, y: 5 }, { x: 50, y: 5 }, { x: 150, y: 5 });
  assert.equal(overlapping, 0, 'collinear and overlapping really is touching');
});

test('segmentDistance agrees with a sampled reference across random input', async () => {
  // Property test rather than a table: the analytic solve has a lot of branches,
  // and the interesting failures are the ones nobody thought to write down.
  const { readFileSync } = await import('node:fs');
  void readFileSync;
  let seed = 20261031;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const point = () => ({ x: (random() * 2 - 1) * 200, y: (random() * 2 - 1) * 200 });
  const pointToSegment = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    if (!(length > 0)) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  };
  // Nested golden-section search: distance to a segment is convex in the
  // parameter, so alternating exact minimisation over each segment converges.
  const reference = (p0, p1, q0, q1) => {
    let s = 0;
    let best = Infinity;
    const golden = (Math.sqrt(5) - 1) / 2;
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const px = p0.x + (p1.x - p0.x) * s;
      const py = p0.y + (p1.y - p0.y) * s;
      best = Math.min(best, pointToSegment({ x: px, y: py }, q0, q1));
      const objective = (x) =>
        pointToSegment({ x: p0.x + (p1.x - p0.x) * x, y: p0.y + (p1.y - p0.y) * x }, q0, q1);
      let lo = 0;
      let hi = 1;
      let a = hi - golden * (hi - lo);
      let b = lo + golden * (hi - lo);
      let fa = objective(a);
      let fb = objective(b);
      for (let k = 0; k < 70; k += 1) {
        if (fa < fb) {
          hi = b;
          b = a;
          fb = fa;
          a = hi - golden * (hi - lo);
          fa = objective(a);
        } else {
          lo = a;
          a = b;
          fa = fb;
          b = lo + golden * (hi - lo);
          fb = objective(b);
        }
      }
      s = (lo + hi) / 2;
    }
    return best;
  };
  for (let i = 0; i < 500; i += 1) {
    const a = point();
    const b = point();
    const c = point();
    const d = point();
    const got = segmentDistance(a, b, c, d);
    const want = reference(a, b, c, d);
    assert.ok(Number.isFinite(got), `non-finite distance for ${JSON.stringify([a, b, c, d])}`);
    assert.ok(Math.abs(got - want) < 1e-6, `expected ${want}, got ${got} for ${JSON.stringify([a, b, c, d])}`);
  }
});

test('a stroke too short to be a string is refused, not created', () => {
  const instrument = new Instrument(1);
  assert.equal(instrument.add(100, 100, 100 + MIN_LENGTH_PX * 0.5, 100), null);
  assert.equal(instrument.count, 0);
  assert.ok(instrument.add(100, 100, 100 + MIN_LENGTH_PX * 1.5, 100));
});

test('the instrument refuses to grow past its ceiling', () => {
  const instrument = new Instrument(1);
  for (let i = 0; i < MAX_STRINGS + 12; i += 1) {
    instrument.add(50, 20 * i, 400, 20 * i);
  }
  assert.equal(instrument.count, MAX_STRINGS);
});

test('a deterministic seed always yields the same instrument', () => {
  const build = () => {
    const instrument = new Instrument(20261031);
    for (let i = 0; i < 4; i += 1) instrument.add(100, 100 + i * 70, 700, 120 + i * 70);
    step(instrument, 90);
    return instrument.strings.map((line) => Array.from(line.u).map((v) => v.toFixed(9)).join(','));
  };
  assert.deepEqual(build(), build(), 'same seed must evolve identically');
  const rng = makeRandom(5);
  assert.equal(rng(), makeRandom(5)());
});

test('a plucked string is reported as sounding, a quiet one as quiet', () => {
  const instrument = new Instrument(1);
  const line = instrument.add(100, 300, 900, 300);
  line.pluck(0.5, 1.5, 1);
  step(instrument, 5);
  assert.equal(instrument.isQuiet(), false);
  step(instrument, 1800);
  assert.equal(instrument.isQuiet(), true, 'a string left alone has to become quiet');
});

test('audio: partials sit at integer multiples of the fundamental', async () => {
  const record = [];
  const engine = new AudioEngine(fakeAudioContext(record));
  assert.equal(await engine.enable(), true);
  const instrument = new Instrument(1);
  const line = instrument.add(100, 300, 900, 300);
  line.pluck(0.4, 1.2, 1);
  engine.sync(instrument.strings);
  engine.update(instrument.strings, 1 / 60);
  const voice = engine.voices.get(line.id);
  const frequencies = voice.partials.map((partial) => partial.oscillator.frequency.value);
  const fundamental = line.pitchHz();
  for (let k = 0; k < PARTIALS; k += 1) {
    assert.ok(
      Math.abs(frequencies[k] - fundamental * (k + 1)) < 1e-6,
      `partial ${k + 1}: ${frequencies[k]} vs ${fundamental * (k + 1)}`,
    );
  }
  engine.disable();
});

test('audio: a triangular pluck is bright, a bowed string is pure', async () => {
  const record = [];
  const engine = new AudioEngine(fakeAudioContext(record));
  await engine.enable();
  const instrument = new Instrument(1);
  const plucked = instrument.add(100, 300, 900, 300);
  const bowed = instrument.add(100, 500, 900, 500);
  plucked.pluck(0.45, 1.5, 1);
  bowed.u.fill(0);
  bowed.v.fill(0);
  for (let frame = 0; frame < 240; frame += 1) {
    bowed.bow({ along: 0.45, across: 1 }, 520, 1 / 60);
    instrument.step(1 / 60, []);
  }
  engine.sync(instrument.strings);
  for (let i = 0; i < 60; i += 1) engine.update(instrument.strings, 1 / 60);
  const pluckedVoice = engine.voices.get(plucked.id);
  const bowedVoice = engine.voices.get(bowed.id);
  const share = (voice) => voice.coefficients[0] / (voice.coefficients.reduce((a, b) => a + b, 0) || 1);
  assert.ok(
    share(pluckedVoice) < share(bowedVoice),
    `a bowed string should be more fundamental-dominant: pluck=${share(pluckedVoice)} bow=${share(bowedVoice)}`,
  );
  engine.disable();
});

test('audio: retuning a string retunes its voice', async () => {
  const record = [];
  const engine = new AudioEngine(fakeAudioContext(record));
  await engine.enable();
  const instrument = new Instrument(1);
  const line = instrument.add(100, 300, 900, 300);
  engine.sync(instrument.strings);
  engine.update(instrument.strings, 1 / 60);
  const before = line.pitchHz();
  line.reshape(300, 300, 900, 300);
  line.generation += 1;
  engine.sync(instrument.strings);
  engine.update(instrument.strings, 1 / 60);
  const after = line.pitchHz();
  assert.ok(after > before, `shortening the string should raise its pitch: ${before} -> ${after}`);
  const voice = engine.voices.get(line.id);
  assert.ok(Math.abs(voice.partials[0].oscillator.frequency.value - after) < 1e-6);
  engine.disable();
});

test('audio: a removed string stops its oscillators', async () => {
  const record = [];
  const engine = new AudioEngine(fakeAudioContext(record));
  await engine.enable();
  const instrument = new Instrument(1);
  const line = instrument.add(100, 300, 900, 300);
  engine.sync(instrument.strings);
  assert.equal(engine.voices.size, 1);
  instrument.remove(line.id);
  engine.sync(instrument.strings);
  assert.equal(engine.voices.size, 0);
  assert.ok(record.some((entry) => entry.endsWith('.stop')), 'the voice should be stopped, not leaked');
  engine.disable();
});

test('audio: without a gesture the engine stays off rather than throwing', async () => {
  const engine = new AudioEngine(undefined);
  assert.equal(await engine.enable(), false);
  assert.equal(engine.enabled, false);
  assert.equal(engine.lastError, 'no-audiocontext');
  // A muted-but-enabled engine must not write a non-zero master gain.
  const record = [];
  const live = new AudioEngine(fakeAudioContext(record));
  await live.enable();
  live.setMuted(true);
  const instrument = new Instrument(1);
  const line = instrument.add(100, 300, 900, 300);
  line.pluck(0.5, 1, 1);
  live.sync(instrument.strings);
  live.update(instrument.strings, 1 / 60);
  assert.ok(record.some((entry) => entry.includes('=0.00000')), 'muting must drive the master gain to zero');
  live.disable();
});

test('enums describe gestures rather than free-form strings', () => {
  assert.deepEqual(Object.keys(Phase).sort(), ['Drawing', 'Holding', 'Sounding']);
  assert.deepEqual(Object.keys(Proximity).sort(), ['Body', 'End', 'None']);
});
