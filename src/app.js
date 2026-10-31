/**
 * Aurelia - app shell: gestures, rendering, onboarding.
 *
 * Two interaction models share one surface:
 *   draw   press in empty space and drag -> the segment from press to release
 *          becomes a string (longer = lower, crossing = ordered voice).
 *   touch  press on an existing string -> pluck by flicking, bow by rubbing,
 *          mute by holding still; drag an endpoint to retune it live.
 *
 * Everything is driven from a single `state` object so the headless tests can
 * read exactly what the user sees.
 */

import { Instrument, Phase, Proximity, MIN_LENGTH_PX, DISPLACEMENT_CLAMP, PITCH_ANCHOR_HZ, PITCH_REFERENCE_PX } from './sim.js';
import { AudioEngine } from './audio.js';

/** What a finger resting on a string is currently doing to it. */
export const TouchMode = {
  Hold: 'hold',
  Bow: 'bow',
};

/** Touch targets, sized from the 44px minimum plus finger slop. */
const HIT = {
  // Body grab must comfortably exceed the demo string spacing, otherwise a
  // finger between two strings is ambiguous and touch play feels broken.
  bodyPx: 62,
  bodyMaxPx: 110,
  endpointPx: 16,
  dragThresholdPx: 7,
  // Rubbing becomes bowing once the finger covers this much ground inside the
  // window. Bow and hold read the same evidence (distance travelled), so the
  // two readings cannot contradict each other.
  bowMinSpeedPxPerS: 55,
  bowWindowMs: 80,
  tapMs: 260,
  minFlickDistancePx: 9,
  maxRetuneLengthPx: 1100,
};

const COLORS = {
  background: '#06070d',
  grid: 'rgba(120,140,190,0.055)',
  guide: 'rgba(255,255,255,0.30)',
  draft: '#e8ecff',
};

/** Shared by every drawing routine; kept module-private on purpose. */
const clamp = (value, low, high) => (value < low ? low : value > high ? value : value);

export class App {
  constructor(canvas, ui, options = {}) {
    this.canvas = canvas;
    this.ui = ui;
    this.context = canvas.getContext('2d', { alpha: false });
    this.instrument = new Instrument(options.seed ?? 20261031);
    this.audio = new AudioEngine(options.AudioContextCtor ?? globalThis.AudioContext ?? globalThis.webkitAudioContext);
    this.pointer = null;
    this.activeGestures = [];
    // Strokes in flight, one per pointer. Keyed by gesture rather than a single
    // shared field, because a second finger must not erase the line the first is
    // still drawing (Android reports multi-touch as independent pointers).
    this.drafts = new Map();
    this.hover = null;
    this.touchMode = TouchMode.Hold;
    this.tweens = new Map();
    this.time = 0;
    this.lastFrame = null;
    this.fps = 60;
    this.reduced = Boolean(options.reducedMotion);
    this.now = options.now ?? (() => performance.now());
    // Where global listeners are attached (keyboard, resize). Injected so a
    // headless test can bind to its own stub instead of a real window.
    this.globalTarget = options.globalTarget ?? globalThis;
    this.showHint = true;
    this.state = {
      phase: Phase.Drawing,
      strings: 0,
      sounding: 0,
      gesture: 'none',
      detail: '',
      pitchHz: null,
      pitchLabel: '',
      ordered: false,
      audio: 'starting',
      hint: 'first-touch',
    };
    this._listeners = [];
    this._resizeObserver = null;
  }

  /* ---------------------------------------------------------------- setup */

  start() {
    this._bindPointer();
    this._bindUi();
    this._bindKeys();
    this._observeResize();
    this.resize();
    this._primeDemo();
    this._tick();
    this._setState({ audio: this.audio.enabled ? 'on' : 'off' });
  }

  destroy() {
    for (const off of this._listeners) off();
    this._listeners = [];
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._raf) this.globalTarget.cancelAnimationFrame?.(this._raf);
    this.audio.disable();
  }

  _on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push(() => target.removeEventListener(type, handler, options));
  }

  _bindUi() {
    if (!this.ui) return;
    const mute = this.ui.querySelector('[data-action=mute]');
    if (mute) {
      this._on(mute, 'click', () => this.toggleMute());
    }
    const clear = this.ui.querySelector('[data-action=clear]');
    if (clear) {
      this._on(clear, 'click', () => this.clearAll());
    }
    const audio = this.ui.querySelector('[data-action=audio]');
    if (audio) {
      this._on(audio, 'click', () => {
        void this.audio.unlock().then((ok) => {
          this._setState({ audio: ok ? 'on' : 'off' });
          this._syncUi();
        });
      });
    }
  }

  _bindKeys() {
    this._on(this.globalTarget, 'keydown', (event) => {
      if (event.metaKey || event.ctrlKey) return;
      if (event.key === 'c' || event.key === 'C') this.clearAll();
      else if (event.key === 'm' || event.key === 'M') this.toggleMute();
      else if (event.key === 'z' || event.key === 'Z') this.undo();
      else if (event.key === 'd' || event.key === 'D') this._primeDemo(true);
    });
  }

  _observeResize() {
    // Read off the target rather than as a bare global: an undeclared identifier
    // throws ReferenceError, which `typeof` alone does not protect against.
    const Observer = this.globalTarget.ResizeObserver;
    if (typeof Observer === 'function') {
      this._resizeObserver = new Observer(() => this.resize());
      this._resizeObserver.observe(this.canvas);
    } else {
      this._on(this.globalTarget, 'resize', () => this.resize());
    }
    this._on(this.globalTarget, 'orientationchange', () => this.resize());
  }

  resize() {
    const parent = this.canvas.parentElement ?? this.canvas;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = clamp(this.globalTarget.devicePixelRatio ?? 1, 1, 2.5);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._relayout();
    this.render();
  }

  /**
   * Keep the instrument visible after a resize or rotation.
   *
   * Two rules, deliberately limited: strings are laid out *inside* the viewport
   * when they are created (see `_primeDemo` / `_anchorFromStroke`), and a resize
   * only translates the group so nothing strands offscreen. Scaling on resize is
   * avoided on purpose - scaling changes length, and length is pitch, so a
   * rotation must never retune the instrument the player just built.
   */
  _relayout() {
    if (this.instrument.count === 0) return;
    const box = this._stringsBox();
    const margin = 16;
    let dx = 0;
    let dy = 0;
    if (box.right > this.width - margin) dx = this.width - margin - box.right;
    else if (box.left < margin) dx = margin - box.left;
    if (box.bottom > this.height - margin) dy = this.height - margin - box.bottom;
    else if (box.top < margin) dy = margin - box.top;
    if (dx === 0 && dy === 0) return;
    for (const line of this.instrument.strings) {
      line.rest.x += dx;
      line.rest.y += dy;
    }
  }

  _stringsBox() {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const line of this.instrument.strings) {
      for (const t of [0, 1]) {
        const point = line.restAt(t);
        left = Math.min(left, point.x);
        right = Math.max(right, point.x);
        top = Math.min(top, point.y);
        bottom = Math.max(bottom, point.y);
      }
    }
    if (!Number.isFinite(left)) return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height, centerX: this.width / 2, centerY: this.height / 2 };
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2,
    };
  }

  /* ------------------------------------------------------------- gestures */

  _bindPointer() {
    const canvas = this.canvas;
    this._on(canvas, 'pointerdown', (event) => this._down(event));
    this._on(canvas, 'pointermove', (event) => this._move(event));
    this._on(canvas, 'pointerup', (event) => this._up(event, false));
    this._on(canvas, 'pointercancel', (event) => this._up(event, true));
    this._on(canvas, 'contextmenu', (event) => event.preventDefault());
    canvas.style.touchAction = 'none';
  }

  _point(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Classify a press: an endpoint wins over the body, which wins over space. */
  _hitTest(x, y) {
    let bestBody = null;
    let bestBodyDistance = HIT.bodyPx;
    for (const line of this.instrument.strings) {
      for (const end of [0, 1]) {
        const point = line.restAt(end);
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance <= HIT.endpointPx) {
          return { line, kind: Proximity.End, end, distance };
        }
      }
      const local = line.toLocal(x, y);
      const along = clamp(local.along, 0, 1);
      const near = line.restAt(along);
      const distance = Math.hypot(near.x - x, near.y - y);
      if (local.along >= 0 && local.along <= 1 && distance <= bestBodyDistance) {
        bestBodyDistance = distance;
        bestBody = { line, kind: Proximity.Body, distance, along: local.along };
      }
    }
    return bestBody ?? { line: null, kind: Proximity.None, distance: Infinity };
  }

  _down(event) {
    if (event.button !== undefined && event.button > 0) return;
    this.canvas.setPointerCapture?.(event.pointerId);
    void this.audio.unlock().then((ok) => {
      if (this.state.audio !== (ok ? 'on' : 'off')) this._setState({ audio: ok ? 'on' : 'off' });
    });
    const point = this._point(event);
    const hit = this._hitTest(point.x, point.y);
    const gesture = {
      id: event.pointerId,
      start: point,
      last: { ...point },
      lastMove: this.now(),
      kind: hit.kind === Proximity.None ? 'draw' : hit.kind === Proximity.End ? 'retune' : 'touch',
      // A retune may legitimately stretch far (that is how low you can go), but
      // it must never collapse a string into noise; see the guard in _move.
      originLengthPx: hit.line ? hit.line.lengthPx : 0,
      line: hit.line,
      end: hit.end,
      moved: 0,
      startedAt: this.now(),
      sounded: false,
    };
    this.activeGestures.push(gesture);
    this.pointer = gesture;
    if (gesture.kind === 'draw') {
      this.drafts.set(gesture.id, { x0: point.x, y0: point.y, x1: point.x, y1: point.y, crossing: null });
      this._syncUi();
    } else if (gesture.kind === 'touch') {
      this.touchMode = TouchMode.Hold;
      gesture.line.held = true;
      this._setState({ gesture: 'hold', detail: 'holding - sound damped' });
    } else {
      this._setState({ gesture: 'retune', detail: 'drag to retune' });
    }
    this._setState({ phase: Phase.Drawing });
  }

  _move(event) {
    const gesture = this.activeGestures.find((item) => item.id === event.pointerId);
    const point = this._point(event);
    if (!gesture) {
      const hit = this._hitTest(point.x, point.y);
      this.hover = { ...hit, x: point.x, y: point.y };
      return;
    }
    const dt = Math.max(0.001, (this.now() - gesture.lastMove) / 1000);
    const dx = point.x - gesture.last.x;
    const dy = point.y - gesture.last.y;
    gesture.moved += Math.hypot(dx, dy);
    gesture.speed = Math.hypot(dx, dy) / dt;
    gesture.last = { ...point };
    gesture.lastMove = this.now();

    if (gesture.kind === 'draw') {
      const draft = this.drafts.get(gesture.id);
      if (!draft) return;
      draft.x1 = point.x;
      draft.y1 = point.y;
      draft.crossing = this.instrument.crossing(draft.x0, draft.y0, point.x, point.y, null);
      const length = Math.hypot(point.x - draft.x0, point.y - draft.y0);
      this._setState({
        detail: length < MIN_LENGTH_PX ? 'drag further to make a string' : `release to sound ~${Math.round(this._pitchForLength(length))} Hz`,
        pitchHz: length >= MIN_LENGTH_PX ? this._pitchForLength(length) : null,
      });
      return;
    }
    if (gesture.kind === 'retune') {
      const line = gesture.line;
      const fixed = line.restAt(gesture.end === 0 ? 1 : 0);
      // Retuning changes length freely, but never below an audible floor and
      // never past the far edge of the field: without a floor a fast flick can
      // collapse the string to a few pixels and jump the pitch by decades.
      const wanted = Math.hypot(point.x - fixed.x, point.y - fixed.y);
      if (wanted < MIN_LENGTH_PX * 1.5) return;
      if (wanted > HIT.maxRetuneLengthPx) return;
      const before = line.pitchHz();
      line.reshape(
        gesture.end === 0 ? point.x : fixed.x,
        gesture.end === 0 ? point.y : fixed.y,
        gesture.end === 1 ? point.x : fixed.x,
        gesture.end === 1 ? point.y : fixed.y,
      );
      line.generation += 1;
      this._setState({
        pitchHz: line.pitchHz(),
        detail: `retuning ${Math.round(before)} Hz -> ${Math.round(line.pitchHz())} Hz`,
      });
      return;
    }
    // Touch gesture: rubbing bows, standing still holds. `gesture.travel`
    // accumulates inside a short window, so slow continuous rubbing still
    // registers, and the mode is sticky until the evidence changes.
    const line = gesture.line;
    if (gesture.travelAt === undefined || this.now() - gesture.travelAt > HIT.bowWindowMs) {
      gesture.travelAt = this.now();
      gesture.travel = 0;
    }
    gesture.travel += Math.hypot(dx, dy);
    const rubbing = gesture.speed > HIT.bowMinSpeedPxPerS || gesture.travel > HIT.bowWindowMs * 0.9;
    if (rubbing) {
      line.held = false;
      this.touchMode = TouchMode.Bow;
      line.bow(line.toLocal(point.x, point.y), gesture.speed, dt);
      gesture.sounded = true;
      this._setState({ gesture: 'bow', detail: 'bowing - rub along it to sustain' });
    } else if (this.touchMode === TouchMode.Bow) {
      this._setState({ gesture: 'bow', detail: 'bowing - rub along it to sustain' });
    }
  }

  _up(event, cancelled) {
    const index = this.activeGestures.findIndex((item) => item.id === event.pointerId);
    if (index < 0) return;
    const gesture = this.activeGestures[index];
    this.activeGestures.splice(index, 1);
    this.canvas.releasePointerCapture?.(event.pointerId);
    const point = this._point(event);

    if (gesture.kind === 'draw') {
      const draft = this.drafts.get(gesture.id);
      this.drafts.delete(gesture.id);
      const length = draft ? Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0) : 0;
      if (!cancelled && length >= MIN_LENGTH_PX) {
        const line = this.instrument.add(draft.x0, draft.y0, draft.x1, draft.y1);
        if (line) {
          line.pluck(0.5, length > this.width * 0.4 ? 1.1 : 0.75, 1);
          this._ripple(point, line.hue);
          this._setState({
            gesture: 'new',
            detail: `new string ~${Math.round(line.pitchHz())} Hz - touch it to play`,
            pitchHz: line.pitchHz(),
            hint: 'played',
          });
        }
      } else {
        this._setState({ gesture: 'none', detail: '' });
      }
    } else if (gesture.kind === 'touch') {
      const line = gesture.line;
      line.held = false;
      const local = line.toLocal(point.x, point.y);
      const pluckAt = (along, strength, detail) => {
        line.pluck(clamp(along, 0.06, 0.94), strength * DISPLACEMENT_CLAMP, 1);
        this._ripple(point, line.hue);
        this._setState({
          gesture: 'pluck',
          detail: `${detail} ~${Math.round(line.pitchHz())} Hz`,
          pitchHz: line.pitchHz(),
        });
      };
      if (gesture.moved >= HIT.minFlickDistancePx) {
        // Flick: pull where the finger actually left the string, as hard as the
        // release speed implies. This is the drag-across-and-let-go gesture.
        pluckAt(local.along, clamp(gesture.speed / 500, 0.4, 1.5), 'plucked');
      } else if (this.now() - gesture.startedAt < HIT.tapMs) {
        // Tap: a clean mid-string pluck so a light touch always sounds.
        pluckAt(0.5, 0.85, 'tapped');
      } else {
        this._setState({ gesture: 'none', detail: 'released - string rings on' });
      }
    } else {
      gesture.line.held = false;
      // Release keeps the retune message on screen: the number is the whole
      // point of the gesture, and clearing it the instant the finger lifts means
      // the player never gets to read what they tuned to.
      if (gesture.kind === 'retune') {
        this._setState({ gesture: 'none' });
      } else {
        this._setState({ gesture: 'none', detail: '' });
      }
    }
    this.pointer = this.activeGestures.at(-1) ?? null;
    this._syncUi();
  }

  /** Same formula the sim uses, so the preview label cannot drift from it. */
  _pitchForLength(lengthPx) {
    return PITCH_ANCHOR_HZ * (PITCH_REFERENCE_PX / Math.max(lengthPx, 1));
  }

  /* ----------------------------------------------------------------- ops */

  clearAll() {
    this.instrument.clear();
    this.audio.sync(this.instrument.strings);
    this._setState({ gesture: 'cleared', detail: 'cleared - draw to begin', hint: 'played', pitchHz: null });
    this._syncUi();
  }

  undo() {
    const removed = this.instrument.strings.at(-1);
    if (!removed) return;
    this.instrument.remove(removed.id);
    this.audio.sync(this.instrument.strings);
    this._setState({ gesture: 'undo', detail: 'removed last string' });
    this._syncUi();
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.muted);
    this._syncUi();
  }

  /**
   * Seed a small instrument so the first thing a visitor sees is a living scene
   * rather than an empty rectangle. Placed from the viewport so it works in
   * portrait and landscape, and plucked once so it is visibly moving.
   */
  _primeDemo(force = false) {
    if (!force && this.instrument.count > 0) return;
    if (force) this.instrument.clear();
    const w = this.width;
    const h = this.height;
    // Three constraints shape this layout:
    //  - String length is pitch, so the lengths differ; the ratio between the
    //    longest and shortest row is what gives the instrument a chord instead
    //    of one blurred unison.
    //  - Vertical spacing stays inside the coupling radius so a pluck visibly
    //    spreads into its neighbours, and inside the body hit radius so a finger
    //    can tell which string it is grabbing.
    //  - Everything must fit the viewport as measured, not as a fraction of it:
    //    the whole instrument is sized from min(width, height * aspect) so the
    //    same code fills a desktop, a portrait phone, and a landscape phone
    //    without any of it falling off-screen.
    const aspect = 0.82;
    const span = Math.min(this.width - 48, (this.height - 120) / aspect);
    const rows = [
      { y: 0.00, from: 0.00, to: 1.00 },
      { y: 0.24, from: 0.07, to: 0.93 },
      { y: 0.48, from: 0.18, to: 0.82 },
      { y: 0.72, from: 0.32, to: 0.68 },
    ];
    const left = (this.width - span) / 2;
    const top = this.height * (0.52 - (rows.length - 1) * 0.12 * aspect);
    for (const row of rows) {
      const y = top + row.y * span * aspect;
      const line = this.instrument.add(left + row.from * span, y, left + row.to * span, y);
      if (line) line.pluck(0.3 + line.id * 0.09, 1.25, 1);
    }
    this._setState({ hint: 'first-touch' });
  }

  /* ------------------------------------------------------------- rendering */

  _ripple(point, hue) {
    if (this.reduced) return;
    this.tweens.set(`${point.x.toFixed(1)}:${point.y.toFixed(1)}:${this.now().toFixed(0)}`, {
      x: point.x,
      y: point.y,
      hue,
      born: this.now(),
      life: 700,
    });
  }

  /**
   * Advance and draw exactly one frame. Split out from the rAF loop so a
   * headless test can step the instrument by hand and get the same result a
   * browser would produce for that frame.
   */
  frame(timestamp) {
    const previous = this.lastFrame ?? timestamp;
    const dt = clamp((timestamp - previous) / 1000, 0.001, 1 / 30);
    this.lastFrame = timestamp;
    this.time += dt;
    this.fps = this.fps * 0.9 + (1 / dt) * 0.1;
    this.instrument.step(dt, this._pointerForces());
    this.audio.sync(this.instrument.strings);
    this.audio.update(this.instrument.strings, dt);
    this.render();
    this._publishState();
  }

  /**
   * The animation loop. rAF supplies the timestamp rather than the app reading a
   * clock, which is what keeps motion smooth across refresh rates.
   */
  _tick() {
    const step = (timestamp) => {
      this._raf = this.globalTarget.requestAnimationFrame(step);
      this.frame(timestamp);
    };
    this._raf = this.globalTarget.requestAnimationFrame(step);
  }

  /** Live gestures that push on strings this frame (bow/hold only). */
  _pointerForces() {
    const forces = [];
    for (const gesture of this.activeGestures) {
      if (gesture.kind !== 'touch' || !gesture.line) continue;
      forces.push({
        lineId: gesture.line.id,
        kind: gesture.line.held ? 'hold' : 'bow',
        x: gesture.last.x,
        y: gesture.last.y,
        speed: gesture.speed ?? 0,
      });
    }
    return forces;
  }

  render() {
    const ctx = this.context;
    if (!ctx || !this.width) return;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);
    this._drawGrid(ctx);
    this._drawRipples(ctx);
    for (const line of this.instrument.strings) this._drawString(ctx, line);
    for (const draft of this.drafts.values()) this._drawDraft(ctx, draft);
    this._drawCursor(ctx);
  }

  _drawGrid(ctx) {
    const spacing = 48;
    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.width; x += spacing) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
    }
    for (let y = 0; y <= this.height; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawRipples(ctx) {
    const cutoff = this.now() - 900;
    for (const [key, ripple] of this.tweens) {
      if (ripple.born < cutoff) {
        this.tweens.delete(key);
        continue;
      }
      const t = (this.now() - ripple.born) / ripple.life;
      if (t >= 1) {
        this.tweens.delete(key);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.strokeStyle = `hsl(${ripple.hue} 90% 70%)`;
      ctx.lineWidth = 2 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, 8 + t * 90, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawString(ctx, line) {
    const amplitude = line.amplitude();
    const loud = clamp(amplitude / 0.55, 0, 1);
    const glow = this.reduced ? 0.25 : 0.2 + 0.8 * Math.max(loud, line.env, line.bowStrength * 0.6);
    const colour = `hsl(${line.hue} ${line.saturation}% ${62 + 18 * loud}%)`;

    if (!this.reduced && glow > 0.05) {
      ctx.save();
      ctx.globalAlpha = 0.16 * glow;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 16 + 26 * glow;
      ctx.lineCap = 'round';
      ctx.shadowColor = colour;
      ctx.shadowBlur = 22 + 40 * glow;
      this._tracePath(ctx, line, true);
      ctx.stroke();
      ctx.restore();
    }

    // Ghost: where the string sits when still, so motion reads as motion.
    ctx.save();
    ctx.globalAlpha = 0.16 + 0.1 * loud;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    this._tracePath(ctx, line, false);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.6 + 3.4 * glow;
    ctx.lineCap = 'round';
    ctx.shadowColor = colour;
    ctx.shadowBlur = this.reduced ? 0 : 8 + 16 * glow;
    this._tracePath(ctx, line, true);
    ctx.stroke();
    ctx.restore();

    this._drawEndpoints(ctx, line, glow);
    if (line.held) this._drawMuteBadge(ctx, line);
  }

  _tracePath(ctx, line, displaced) {
    ctx.beginPath();
    const n = line.n;
    for (let i = 0; i < n; i += 1) {
      const point = displaced ? line.pointAt(i) : line.pointAt(i, 0);
      const base = displaced ? point : line.restAt(i / (n - 1));
      if (i === 0) ctx.moveTo(base.x, base.y);
      else ctx.lineTo(base.x, base.y);
    }
  }

  /**
   * Anchors double as the only retune control, so they are drawn as rings with
   * a solid core rather than dots: a ring reads as "grab me" at a glance, and
   * the ring radius matches the hit radius it is given.
   */
  _drawEndpoints(ctx, line, glow) {
    for (const end of [0, 1]) {
      const point = line.restAt(end);
      const active = this.pointer?.line === line && this.pointer?.kind === 'retune';
      ctx.save();
      ctx.globalAlpha = active ? 1 : 0.7 + 0.3 * glow;
      ctx.strokeStyle = `hsl(${line.hue} ${line.saturation}% 80%)`;
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, active ? 11 : 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = active ? '#ffffff' : `hsl(${line.hue} ${line.saturation}% 72%)`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, active ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawMuteBadge(ctx, line) {
    const point = line.restAt(0.5);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#0b0d16';
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MUTE', point.x, point.y);
    ctx.restore();
  }

  _drawDraft(ctx, draft) {
    const length = Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0);
    const short = length < MIN_LENGTH_PX;
    ctx.save();
    ctx.setLineDash(short ? [3, 7] : []);
    ctx.strokeStyle = short ? 'rgba(255,255,255,0.45)' : COLORS.draft;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = draft.crossing ? 'rgba(255,255,255,0.9)' : 'rgba(160,190,255,0.8)';
    ctx.shadowBlur = draft.crossing ? 18 : 8;
    ctx.beginPath();
    ctx.moveTo(draft.x0, draft.y0);
    ctx.lineTo(draft.x1, draft.y1);
    ctx.stroke();
    ctx.restore();

    if (draft.crossing) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('crossing: becomes an ordered voice', draft.x1 + 12, draft.y1 - 10);
      ctx.restore();
    } else if (!short) {
      ctx.save();
      ctx.fillStyle = 'rgba(220,230,255,0.75)';
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(`~${Math.round(this._pitchForLength(length))} Hz`, draft.x1 + 12, draft.y1 - 10);
      ctx.restore();
    }
  }

  /**
   * The "you can play this" affordance: a ring snapped to the nearest string
   * under the pointer. Drawn on hover (mouse) so the touch instructions have a
   * visible referent, and it is the same ring a finger activates.
   */
  _drawCursor(ctx) {
    const hover = this.hover;
    if (!hover || hover.kind === Proximity.None || !hover.line) return;
    const line = hover.line;
    const local = line.toLocal(hover.x ?? 0, hover.y ?? 0);
    const t = clamp(local.along, 0, 1);
    const point = line.restAt(t);
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = `hsl(${line.hue} 90% 78%)`;
    ctx.lineWidth = hover.kind === Proximity.End ? 2.5 : 1.75;
    ctx.beginPath();
    ctx.arc(point.x, point.y, hover.kind === Proximity.End ? 13 : 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- state */

  _setState(patch) {
    Object.assign(this.state, patch);
  }

  /** Derive the readout every frame from simulation state, not from handlers. */
  _publishState() {
    let sounding = 0;
    let loudest = 0;
    let loudestLine = null;
    for (const line of this.instrument.strings) {
      const amplitude = line.amplitude();
      if (amplitude > 0.012) sounding += 1;
      if (amplitude > loudest) {
        loudest = amplitude;
        loudestLine = line;
      }
    }
    const phase = this.drafts.size > 0
      ? Phase.Drawing
      : sounding > 0
        ? Phase.Sounding
        : this.activeGestures.length > 0
          ? Phase.Holding
          : Phase.Sounding;
    const hint = this.instrument.count > 0 ? (sounding > 0 ? 'played' : 'idle') : this.state.hint;
    this._setState({
      strings: this.instrument.count,
      sounding,
      phase,
      hint,
      energy: this.instrument.totalEnergy(),
      quiet: this.instrument.isQuiet(),
    });
    if (this.state.pitchHz === null && loudestLine) {
      this._setState({ pitchHz: loudestLine.pitchHz() });
    }
  }

  _syncUi() {
    if (!this.ui) return;
    const mute = this.ui.querySelector('[data-action=mute]');
    if (mute) {
      mute.setAttribute('aria-pressed', String(this.audio.muted));
      mute.textContent = this.audio.muted ? 'Sound off' : 'Sound on';
    }
    const audio = this.ui.querySelector('[data-action=audio]');
    if (audio) audio.dataset.state = this.state.audio;
  }
}
