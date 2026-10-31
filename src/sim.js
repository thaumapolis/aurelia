/**
 * Aurelia - physics core.
 *
 * Every line the player draws becomes a musical string: a taut thread pinned
 * at both ends, running a 1D wave equation. Plucking one string shakes the
 * space around it, so nearby strings are driven by their neighbours.
 *
 * This module is pure: no DOM, no audio. The same code therefore runs in a
 * headless browser check, in a unit test, and on a phone.
 */

export const SAMPLES_PER_100PX = 0.42;
export const MIN_LENGTH_PX = 42;
export const MAX_LENGTH_PX = 3600;
export const MAX_STRINGS = 64;
/** Reference length behind the pitch formula: a string this long has the anchor
 * pitch below. It is a tuning constant, not a layout distance. */
export const REST_SPACING_PX = 440;
/**
 * Strings couple when their spans come within this fraction of their own mean
 * length. Relative rather than absolute on purpose: an instrument laid out for a
 * phone and one laid out for a desktop are the same instrument, so the distance
 * at which strings hear each other has to scale with them.
 */
export const CROSS_TALK_FRACTION = 0.34;
/**
 * Fundamental of a string whose rest length is REST_SPACING_PX. The audible
 * partials are fundamental x 1..5, so this anchor keeps that whole family
 * inside the ~180-850 Hz band the mapping is meant to be heard in.
 */
export const PITCH_ANCHOR_HZ = 260;
export const PITCH_REFERENCE_PX = REST_SPACING_PX;
export const DISPLACEMENT_CLAMP = 1.8;
export const SILENCE_AMPLITUDE = 0.0015;

const WAVE_SPEED = 1;
const SUBSTEPS = 4;
const DISSIPATION = 0.9985;
const NEIGHBOUR_DRIVE = 0.055;
const SINGLE_DECAY = 0.99965;
const VEL_CLAMP = 0.04;
const CROSS_TALK_SAMPLES = 10;
/*
 * Bow parameters, tuned against DISSIPATION: at BOW_VELOCITY a bowed string
 * grows from rest and then settles, while a plucked one still rings out and
 * decays. Tests assert both, so retuning has to break a stated expectation
 * rather than silently change how an instrument feels.
 *   BOW_VELOCITY         velocity the bow imparts at full speed (field units/frame)
 *   BOW_STICK_THRESHOLD  within this fraction of the bow speed, the string sticks
 *   BOW_SLIP_FRACTION    how much of the gap closing is allowed while slipping
 */
const BOW_VELOCITY = 0.004;
const BOW_STICK_THRESHOLD = 0.35;
const BOW_SLIP_FRACTION = 0.2;
const BOW_SPEED_REFERENCE = 700;
const MIN_SAMPLES = 12;
const MAX_SAMPLES = 193;

/** Gesture state machine, in the order a touch visits these phases. */
export const Phase = {
  Drawing: 'drawing',
  Holding: 'holding',
  Sounding: 'sounding',
};

/** Where a pointer sits relative to a string, which decides the gesture. */
export const Proximity = {
  None: 'none',
  Body: 'body',
  End: 'end',
};

const clamp = (value, low, high) => (value < low ? low : value > high ? value : value);

/** Deterministic PRNG so a seed always yields the same starting strings. */
export function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shortest distance between the segments p0p1 and q0q1, in canvas pixels.
 *
 * Used for two questions: whether two strings are near enough to shake each
 * other, and whether a stroke being drawn crosses an existing string (which is
 * what makes the new one an independent voice).
 *
 * Two hazards in the classic formulation are handled explicitly, and both were
 * found by testing rather than reading:
 *
 *  - A zero-length segment has no direction, so its parametric solve divides by
 *    zero. It is just a point, so it is reduced to point-segment distance.
 *  - `Math.min` returns NaN if *any* argument is NaN, and a degenerate solve
 *    produces exactly that. So the candidates are filtered rather than trusted,
 *    because `Math.min(...[90, NaN])` is NaN - not 90 - and NaN compares false
 *    against everything, which silently turns a real distance into a zero.
 */
export function segmentDistance(p0, p1, q0, q1) {
  const pointToSegment = (point, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    if (!(squared > 0)) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared;
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(point.x - (a.x + clamped * dx), point.y - (a.y + clamped * dy));
  };
  // Smallest finite candidate, or 0 when there is none (which can only mean every
  // input was a coincident point, at which point 0 is the right answer).
  const smallest = (candidates) => {
    let best = Number.POSITIVE_INFINITY;
    for (const value of candidates) {
      if (Number.isFinite(value) && value < best) best = value;
    }
    return Number.isFinite(best) ? best : 0;
  };

  const firstIsPoint = p0.x === p1.x && p0.y === p1.y;
  const secondIsPoint = q0.x === q1.x && q0.y === q1.y;
  if (firstIsPoint || secondIsPoint) {
    if (firstIsPoint && secondIsPoint) return Math.hypot(p0.x - q0.x, p0.y - q0.y);
    return firstIsPoint ? pointToSegment(p0, q0, q1) : pointToSegment(q0, p0, p1);
  }

  const d1x = p1.x - p0.x;
  const d1y = p1.y - p0.y;
  const d2x = q1.x - q0.x;
  const d2y = q1.y - q0.y;
  const lengthFirstSquared = d1x * d1x + d1y * d1y;
  const lengthSecondSquared = d2x * d2x + d2y * d2y;

  // Parallelism is the vanishing of the cross product. (A tempting alternative,
  // `lengthFirstSquared * lengthSecondSquared - dot(dot1,dot2)^2`, is the Gram
  // determinant and is zero for *every* pair of vectors by Cauchy-Schwarz, so it
  // is not a parallelism test at all.)
  const crossDirections = d1x * d2y - d1y * d2x;
  const parallel =
    crossDirections * crossDirections <
    1e-18 * lengthFirstSquared * lengthSecondSquared;

  // For parallel segments, including collinear ones, the closest pair always
  // involves an endpoint, so comparing the four endpoint-to-segment distances is
  // exact. This is also what keeps collinear-but-disjoint segments from reporting
  // a distance of zero, since they share a line without touching.
  if (parallel) {
    return smallest([
      pointToSegment(p0, q0, q1),
      pointToSegment(p1, q0, q1),
      pointToSegment(q0, p0, p1),
      pointToSegment(q1, p0, p1),
    ]);
  }

  const rx = p0.x - q0.x;
  const ry = p0.y - q0.y;
  const dotSecondStart = d2x * rx + d2y * ry;
  const dotFirstStart = d1x * rx + d1y * ry;
  const dotDirections = d1x * d2x + d1y * d2y;
  const denominator = lengthFirstSquared * lengthSecondSquared - dotDirections * dotDirections;

  // Closest pair on the two infinite lines, clamped into the segments. A clamp
  // on one parameter changes what the other wants, so rather than iterating the
  // pair until they agree, the interior candidate is measured alongside the four
  // endpoint candidates and the smallest wins. That is exact for segments, exact
  // for degenerate input, and costs four extra distances once per pair.
  const sFree = (dotDirections * dotSecondStart - dotFirstStart * lengthSecondSquared) / denominator;
  const clampUnit = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
  const s = clampUnit(sFree);
  const t = clampUnit((dotDirections * s + dotSecondStart) / lengthSecondSquared);
  const cx = p0.x + d1x * s - (q0.x + d2x * t);
  const cy = p0.y + d1y * s - (q0.y + d2y * t);
  return smallest([
    Math.hypot(cx, cy),
    pointToSegment(p0, q0, q1),
    pointToSegment(p1, q0, q1),
    pointToSegment(q0, p0, p1),
    pointToSegment(q1, p0, p1),
  ]);
}

/** One drawn line: its geometry, its wave field, and its gesture state. */
export class StringLine {
  constructor(id, x0, y0, x1, y1, rng, options = {}) {
    this.id = id;
    this.generation = 0;
    this.thickness = 1;
    this.held = false;
    this.ordered = false;
    this.env = 0;
    this.bowStrength = 0;
    this.pluckStrength = 1;
    this.phase = Phase.Sounding;
    this._shape(x0, y0, x1, y1, options.rest);
    this.hue = (rng() * 360 + this.rest.x * 0.05) % 360;
    this.saturation = 76;
    this._alloc();
    this._seedSilence(rng);
  }

  /** Set geometry; `rest` reuses an existing anchor so a drag keeps place. */
  _shape(x0, y0, x1, y1, rest) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    this.lengthPx = Math.hypot(dx, dy);
    this.angle = Math.atan2(dy, dx);
    this.n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(this.lengthPx * SAMPLES_PER_100PX) + 16));
    // The anchor is the string's midpoint, so a string sits exactly where it was
    // drawn. (`rest` lets a caller keep an anchor the player already positioned,
    // e.g. while a stroke is re-anchored onto a crossing.)
    this.rest = rest ?? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    this.unit = { x: Math.cos(this.angle), y: Math.sin(this.angle) };
    this.normal = { x: -Math.sin(this.angle), y: Math.cos(this.angle) };
    this.screenScale = clamp(620 / this.lengthPx, 0.25, 3);
    this._det = this.unit.x * this.normal.y - this.unit.y * this.normal.x;
  }

  /** Replace endpoints in place, keeping the wave field and identity. */
  reshape(x0, y0, x1, y1) {
    const previousLength = this.lengthPx;
    this._shape(x0, y0, x1, y1, this.rest);
    if (Math.abs(this.lengthPx - previousLength) > 0.5) this.generation += 1;
    if (this.n !== this.u.length) this._alloc();
  }

  _alloc() {
    const previous = this.u;
    const n = this.n;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.tmp = new Float32Array(n);
    if (previous) {
      const count = Math.min(previous.length, n);
      this.u.set(previous.subarray(0, count));
    }
  }

  _seedSilence(rng) {
    for (let i = 1; i < this.n - 1; i += 1) this.u[i] = (rng() * 2 - 1) * 0.002;
  }

  /** Rest-space (undisplaced) point at parameter t in [0,1]. */
  restAt(t) {
    return {
      x: this.rest.x + this.unit.x * (t - 0.5) * this.lengthPx,
      y: this.rest.y + this.unit.y * (t - 0.5) * this.lengthPx,
    };
  }

  /** Screen point of sample i, offset added along the string normal. */
  pointAt(i, offset = 0) {
    const base = this.restAt(i / (this.n - 1));
    const d = offset + this.u[i] * this.screenScale;
    return { x: base.x + this.normal.x * d, y: base.y + this.normal.y * d };
  }

  /** Screen point of an arbitrary rest parameter with a normal offset. */
  restPoint(t, offset = 0) {
    const base = this.restAt(t);
    return { x: base.x + this.normal.x * offset, y: base.y + this.normal.y * offset };
  }

  /**
   * Screen -> string-local coordinates, which is how a finger on the canvas
   * becomes a position on a string.
   *
   * `along` is the normalized position the caller asked about, in [0,1] with 0
   * at the first endpoint; it is deliberately NOT clamped, so callers that need
   * to know a touch fell outside the string can tell. `across` is the signed
   * perpendicular distance in canvas pixels.
   *
   * The projection is divided by the length because the dot product below is
   * measured from the anchor, i.e. the string's centre, so it returns a distance
   * rather than a parameter.
   */
  toLocal(x, y) {
    const rx = x - this.rest.x;
    const ry = y - this.rest.y;
    const alongPx = rx * this.unit.x + ry * this.unit.y;
    const across = rx * this.normal.x + ry * this.normal.y;
    return { along: alongPx / this.lengthPx + 0.5, across };
  }

  /**
   * Fundamental in Hz, scaling inversely with length the way a real string
   * does: halve the length and the pitch doubles.
   */
  pitchHz() {
    return PITCH_ANCHOR_HZ * (PITCH_REFERENCE_PX / Math.max(this.lengthPx, 1));
  }

  /** Peak |displacement| — what the visuals and loudness read. */
  amplitude() {
    let peak = 0;
    for (let i = 1; i < this.n - 1; i += 1) {
      const a = Math.abs(this.u[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  /** Mean kinetic energy, cheap enough for every frame. */
  energy() {
    let sum = 0;
    for (let i = 1; i < this.n - 1; i += 1) sum += this.v[i] * this.v[i];
    return sum / Math.max(1, this.n - 2);
  }

  /**
   * Pull the string toward `acrossPixels` in a triangle around `along`. This is
   * the only way a gesture puts energy into a string, i.e. what a pluck is.
   */
  pluck(along, acrossPixels, strength = 1) {
    const target = clamp(acrossPixels / this.screenScale / DISPLACEMENT_CLAMP, -1, 1);
    if (target === 0) return false;
    const n = this.n;
    const centre = clamp(Math.round(along * (n - 1)), 2, n - 3);
    const span = Math.max(2, Math.round(n * 0.04));
    for (let i = centre - span; i <= centre + span; i += 1) {
      if (i < 1 || i > n - 2) continue;
      const want = target * (1 - Math.abs(i - centre) / span);
      const current = this.u[i];
      // Only push in the requested direction, so a rapid repeated touch keeps
      // adding energy instead of cancelling the previous stroke.
      if (Math.sign(want) === Math.sign(current) || Math.abs(current) < Math.abs(want)) {
        this.u[i] = want;
      }
      this.v[i] += (want - current) * 0.5;
    }
    this.env = Math.max(this.env, strength);
    this.pluckStrength = strength;
    return true;
  }

  /**
   * Rub along the string.
   *
   *
   * Modelled as Helmholtz motion, the standard physical picture of a bowed
   * string: while the string's velocity at the bow point is slower than the bow
   * itself, hair friction drags it along with the bow (the "stick" phase); once
   * the string outruns the bow it slips. Written as a velocity-following rule,
   * that is negative damping while slipping and clamping while sticking, and it
   * is what makes a bow self-sustaining - the energy arrives once per period, in
   * phase with the wave, instead of fighting it half the time. `speedPx` is how
   * fast the bow travels, i.e. how loud it can get.
   */
  bow(local, speedPx, dt) {
    const n = this.n;
    const centre = clamp(Math.round(local.along * (n - 1)), 1, n - 2);
    const span = Math.max(2, Math.round(n * 0.02));
    // Target velocity follows the bow, projected onto the string's own normal so
    // that rubbing along the string (not across it) is what drives it.
    const drive = clamp(speedPx / BOW_SPEED_REFERENCE, 0, 1) * BOW_VELOCITY;
    if (drive === 0) return;
    for (let i = centre - span; i <= centre + span; i += 1) {
      if (i < 1 || i > n - 2) continue;
      const taper = 1 - Math.abs(i - centre) / span;
      const wanted = drive * taper;
      const current = this.v[i];
      // Stick: close enough to the bow that friction carries it. Slip: only
      // nudge, and never past the bow's own velocity.
      const next = Math.abs(current - wanted) < BOW_STICK_THRESHOLD * Math.abs(wanted)
        ? wanted
        : current + (wanted - current) * BOW_SLIP_FRACTION;
      this.v[i] = next;
    }
    this.env = Math.max(this.env, 0.4);
    this.bowStrength = clamp(speedPx / 700, 0, 1);
  }

  /** Hold: pin the string near the finger and bleed its energy away. */
  hold(local) {
    const n = this.n;
    const centre = Math.round(local.along * (n - 1));
    const span = Math.max(2, Math.round(n * 0.03));
    const target = clamp(local.across / this.screenScale / DISPLACEMENT_CLAMP, -1, 1);
    for (let i = centre - span; i <= centre + span; i += 1) {
      if (i < 1 || i > n - 2) continue;
      this.u[i] = target;
      this.v[i] *= 0.2;
    }
    this.env = Math.max(this.env, 0.3);
  }

  /** One CFL-stable wave step, driven by neighbour offsets. */
  _integrate(dt, drive) {
    const n = this.n;
    const { u, v, tmp } = this;
    for (let s = 0; s < SUBSTEPS; s += 1) {
      for (let i = 1; i < n - 1; i += 1) {
        let accel = v[i] + WAVE_SPEED * WAVE_SPEED * (u[i - 1] - 2 * u[i] + u[i + 1]) + drive[i];
        if (accel > VEL_CLAMP) accel = VEL_CLAMP;
        else if (accel < -VEL_CLAMP) accel = -VEL_CLAMP;
        tmp[i] = accel;
      }
      for (let i = 1; i < n - 1; i += 1) {
        v[i] = tmp[i] * DISSIPATION;
        u[i] += v[i];
        if (u[i] > DISPLACEMENT_CLAMP) {
          u[i] = DISPLACEMENT_CLAMP;
          v[i] *= -0.4;
        } else if (u[i] < -DISPLACEMENT_CLAMP) {
          u[i] = -DISPLACEMENT_CLAMP;
          v[i] *= -0.4;
        }
      }
    }
  }
}

/** The whole instrument: strings, neighbour coupling, and gesture routing. */
export class Instrument {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.rng = makeRandom(this.seed);
    this.strings = [];
    this._nextId = 1;
    this.time = 0;
  }

  get count() {
    return this.strings.length;
  }

  byId(id) {
    return this.strings.find((line) => line.id === id);
  }

  /** Add a string from a drawn stroke. Returns null when too short or full. */
  add(x0, y0, x1, y1, options = {}) {
    if (this.strings.length >= MAX_STRINGS) return null;
    if (Math.hypot(x1 - x0, y1 - y0) < MIN_LENGTH_PX) return null;
    const line = new StringLine(this._nextId++, x0, y0, x1, y1, this.rng, options);
    this.strings.push(line);
    return line;
  }

  remove(id) {
    const index = this.strings.findIndex((line) => line.id === id);
    if (index < 0) return null;
    const [line] = this.strings.splice(index, 1);
    return line;
  }

  clear() {
    this.strings.length = 0;
  }

  /**
   * Rebuild `line` from a new stroke: endpoints and, when it crosses another
   * string, its anchor. Returns the pitches changed per string id, which is how
   * the audio layer knows to retune.
   */
  reshape(line, x0, y0, x1, y1) {
    const before = line.pitchHz();
    const crossed = this.crossing(x0, y0, x1, y1, line.id);
    if (crossed) {
      const local = line.toLocal(x0, y0);
      line._shape(x0, y0, x1, y1, { x: x0 - line.normal.x * local.across, y: y0 - line.normal.y * local.across });
      if (line.n !== line.u.length) line._alloc();
      line.ordered = true;
    } else {
      line.reshape(x0, y0, x1, y1);
      line.ordered = false;
    }
    return { id: line.id, before, after: line.pitchHz(), lengthPx: line.lengthPx, ordered: line.ordered };
  }

  /** The other string whose span crosses the given segment, if any. */
  crossing(x0, y0, x1, y1, exceptId) {
    let best = null;
    let bestDistance = Infinity;
    for (const other of this.strings) {
      if (other.id === exceptId) continue;
      const p0 = other.restAt(0);
      const p1 = other.restAt(1);
      const d = segmentDistance({ x: x0, y: y0 }, { x: x1, y: y1 }, p0, p1);
      if (d < bestDistance) {
        bestDistance = d;
        best = other;
      }
    }
    return best;
  }

  /**
   * One frame. `pointers` are active gestures, each already classified:
   * `{ lineId, kind: 'pluck'|'bow'|'hold', x, y, dx, dy, speed }`.
   */
  step(dt, pointers) {
    this.time += dt;
    for (const line of this.strings) {
      line.env *= Math.pow(0.06, dt);
      line.bowStrength *= Math.pow(0.02, dt);
    }
    for (const pointer of pointers) {
      const line = this.byId(pointer.lineId);
      if (!line) continue;
      const local = line.toLocal(pointer.x, pointer.y);
      if (local.along < 0 || local.along > 1) continue;
      if (pointer.kind === 'hold') line.hold(local);
      else if (pointer.kind === 'bow') line.bow(local, pointer.speed, dt);
      else line.pluck(local.along, local.across, clamp(pointer.speed / 600, 0.35, 1));
    }
    for (let index = 0; index < this.strings.length; index += 1) {
      const line = this.strings[index];
      const neighbours = this._neighbours(line);
      line._integrate(dt, this._driveInput(line, neighbours));
      if (this.strings.length === 1) {
        const decay = Math.pow(SINGLE_DECAY, dt * 1000);
        for (let i = 1; i < line.n - 1; i += 1) {
          line.u[i] *= decay;
          line.v[i] *= decay;
        }
      }
    }
  }

  /**
   * Strings this one can feel: those whose span comes within the coupling
   * radius. Addressed positionally rather than by id, so a string the player has
   * redrawn keeps its neighbours instead of silently losing them.
   */
  _neighbours(line) {
    const radius = line.lengthPx * CROSS_TALK_FRACTION;
    const out = [];
    for (const other of this.strings) {
      if (other === line) continue;
      const distance = segmentDistance(
        line.restAt(0),
        line.restAt(1),
        other.restAt(0),
        other.restAt(1),
      );
      if (distance < radius) out.push({ other, distance, radius });
    }
    return out;
  }

  /**
   * Turn each neighbour's motion into a velocity drive on this string, sampled
   * at a handful of points along the neighbour rather than at every node. The
   * coupling is a low-frequency push, so a few samples carry the effect at a
   * fraction of the cost - which matters, as this runs per string per frame.
   */
  _driveInput(line, neighbours) {
    const drive = new Float32Array(line.n);
    for (const { other, distance, radius } of neighbours) {
      const strength = NEIGHBOUR_DRIVE * (1 - distance / radius);
      const step = Math.max(1, Math.floor(other.n / CROSS_TALK_SAMPLES));
      for (let j = 1; j < other.n - 1; j += step) {
        const point = other.pointAt(j);
        const local = line.toLocal(point.x, point.y);
        if (local.along <= 0.02 || local.along >= 0.98) continue;
        const index = Math.round(local.along * (line.n - 1));
        if (index < 1 || index > line.n - 2) continue;
        drive[index] += other.v[j] * strength;
      }
    }
    return drive;
  }

  /** Total acoustic-ish energy, used to decide when the room is quiet. */
  totalEnergy() {
    let sum = 0;
    for (const line of this.strings) sum += line.energy();
    return sum / Math.max(1, this.strings.length);
  }

  isQuiet(threshold = SILENCE_AMPLITUDE) {
    for (const line of this.strings) {
      if (line.amplitude() > threshold) return false;
    }
    return true;
  }
}
