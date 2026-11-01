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

import { Instrument, Phase, Proximity, clamp, MIN_LENGTH_PX, DISPLACEMENT_CLAMP, PITCH_ANCHOR_HZ, PITCH_REFERENCE_PX } from './sim.js';
import { AudioEngine } from './audio.js';
/**
 * The font the canvas draws its own labels with.
 *
 * The family name must match the `@font-face` rules the build inlines into
 * the stylesheet, so canvas text and panel text are set in the same embedded
 * face. Repeating `ui-sans-serif, system-ui, ...` here instead would hand the
 * choice back to the host: the panels and the canvas would disagree, and the
 * same artifact would render differently on another machine. See fontFaceCss
 * in tools/build-lib.mjs for the faces themselves.
 */
const FONT_STACK = '"Aurelia Sans", sans-serif';

/** What a finger resting on a string is currently doing to it. */
export const TouchMode = {
  Hold: 'hold',
  Bow: 'bow',
};

/**
 * Touch targets, sized from the 44px minimum plus finger slop.
 *
 * `bodyPx` is a floor rather than the whole answer - see `bodyGrabPx`. On a phone
 * the instrument is small and its strings are about 60px apart, so the grab
 * radius has to exceed that gap or a finger between two strings matches neither
 * and every touch falls through to "draw a new string". On a desktop the same
 * instrument is spread three times wider, where a fixed 62px radius would demand
 * aiming at a string, which is not what "touch a string" should ask of anyone.
 */
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
  // How long, in seconds of simulated time, the readout keeps describing an
  // action after the finger leaves. Long enough to read; short enough that it
  // never looks stuck. Simulated rather than wall time because the number that
  // ages it is the same clock the wave runs on.
  messageHoldSeconds: 3.2,
  minFlickDistancePx: 9,
  // A touch becomes a bow once the finger has travelled this far *along* the
  // string without leaving it. Set well above the wander of a held finger and
  // below the length of a deliberate stroke.
  bowTravelPx: 26,
  // How strictly a stroke must follow the string to count as rubbing rather
  // than pulling across: travel along, divided by distance from the string,
  // must beat this. ~2.5 means a 14 degree stroke is a bow and a 30 degree
  // pull is a pluck - the distinction a person can hear with their own finger.
  bowAlignment: 2.5,
  // Ceiling for dragging a tuning handle, as a fraction of the field diagonal.
  // Unlike a pluck, a deliberate retune may travel far, so it gets the whole
  // field; the body radius is what keeps two neighbours distinguishable.
  maxRetuneLengthRatio: 0.95,
  // Ceiling on the body grab radius, so a lone long string on a huge display
  // does not turn the whole canvas into "string" and make new ones impossible
  // to draw.
  grabMaxPx: 140,
};

/**
 * Longest single step the gesture clock will accept, in ms.
 *
 * A frame that took longer than this is not a slow finger, it is a stalled
 * animation loop: a backgrounded tab, a breakpoint, or a screenshot driver
 * pausing between two synthetic pointer events. Counting the real elapsed time
 * in those cases would divide a small distance by a large interval and report a
 * violent flick, so the interval is clamped instead and the gesture reads as the
 * deliberate drag that it was.
 */
const GESTURE_FRAME_MS = 1000 / 60;

/** Height of the seeded instrument as a fraction of its width. */
const DEMO_ASPECT = 0.82;

/**
 * The seeded instrument: four rows, inset from one another so the lengths differ
 * and it sounds a chord rather than one blurred unison. `y` is a row's position
 * as a fraction of the instrument's height.
 *
 * The lowest row sits at 0.72 rather than 1.0 so the stack is visually centred
 * inside the box its own endpoints describe. DEMO_ROWS_BOTTOM below repeats that
 * number instead of reading it back off this array, deliberately: an earlier
 * `const` that refers to a later one is a temporal dead zone, and where it does
 * not throw it yields undefined - which becomes NaN in a division, and `Math.max`
 * of NaN is NaN, so the clamp that keeps the instrument on screen stops clamping
 * and every string is placed at NaN. Repetition here is cheaper than a layout
 * that silently produces nothing.
 */
const DEMO_ROWS = [
  { y: 0.00, from: 0.00, to: 1.00 },
  { y: 0.24, from: 0.07, to: 0.93 },
  { y: 0.48, from: 0.18, to: 0.82 },
  { y: 0.72, from: 0.32, to: 0.68 },
];

/** Where the lowest row sits, as a fraction of the instrument's height. */
const DEMO_ROWS_BOTTOM = 0.72;

/**
 * Where the seeded instrument would sit inside `area`: the span, and the rows
 * in their final positions. This is the one description of the placement -
 * `_primeDemo` draws it, `fitsIn` and the lesson check ask it questions - so
 * the estimate of what the panel hides cannot drift from where the strings
 * actually go.
 *
 * Three constraints shape it:
 *  - String length is pitch, so the rows differ in length; the ratio between
 *    the longest and shortest is what gives a chord instead of one blurred
 *    unison.
 *  - Vertical spacing stays inside the coupling radius, so a pluck visibly
 *    spreads into its neighbours, and inside the grab radius, so a finger can
 *    tell which string it is holding.
 *  - It fits the area as measured, not as a fraction of the screen, so the same
 *    code fills a desktop, a portrait phone and a landscape phone.
 *
 * What decides the size is the extent the rows occupy: the longest string sets
 * the width, and the gap from the first row to the last sets the height. Taking
 * the smaller of the two ratios makes the instrument as large as the area allows
 * on whichever axis is tighter. The rows are then placed within the area itself,
 * not within a box centred on it - centring the box puts the first row half the
 * unused height above the top of the screen.
 */
function _demoLayout(area) {
  const areaWidth = area.right - area.left;
  const areaHeight = area.bottom - area.top;
  const spanByWidth = areaWidth;
  const spanByHeight = areaHeight / (DEMO_ROWS_BOTTOM * DEMO_ASPECT);
  const span = Math.max(MIN_AUDIBLE_LENGTH_PX, Math.min(spanByWidth, spanByHeight));
  const left = area.left + (areaWidth - span) / 2;
  const usedHeight = span * DEMO_ROWS_BOTTOM * DEMO_ASPECT;
  const top = area.top + (areaHeight - usedHeight) / 2;
  return {
    span,
    top,
    rows: DEMO_ROWS.map((row) => {
      const rowLeft = left + row.from * span;
      const rowRight = left + row.to * span;
      return {
        y: top + row.y * span * DEMO_ASPECT,
        left: rowLeft,
        right: rowRight,
        length: rowRight - rowLeft,
      };
    }),
  };
}

/**
 * A string this short is a mistake, not a note: it sounds more like a click than
 * a pitch, and the shortest seeded string is deliberately longer. Kept separate
 * from the simulator's own floor, which is about what the physics will
 * integrate rather than what is worth hearing.
 */
const MIN_AUDIBLE_LENGTH_PX = 96;

/** Panels that always block the instrument: they never go away on their own. */
const CHROME_SELECTOR = '#brand, #meters, #readout, #controls, #about';

/**
 * What fraction of the instrument the lesson may hide before the instrument
 * moves instead. The unit is string-length, not screen area and not width: see
 * `_lessonHidesRows`. 0.4 separates the three real viewports with room either
 * side of it (desktop 0.17, landscape 0.47, portrait 1.00), which is the widest
 * honest margin available - it is a judgement call about how much occlusion a
 * transient panel is worth, not a number derived from anything.
 */
const LESSON_MAX_HIDDEN_SHARE = 0.4;

/** The teaching panel. A temporary obstacle: it dismisses on first use. */
const LESSON_SELECTOR = '#learn';

/** Breathing room between the instrument and any panel or canvas edge. */
const FREE_AREA_MARGIN_PX = 14;

/** How close to a screen edge a panel must be to count as anchored to it. */
const ANCHOR_EDGE_FRACTION = 0.06;

/** A panel at least this tall, relative to the screen, is a side column. */
const COLUMN_MIN_HEIGHT = 0.45;

/** A panel this wide is a band across the screen, not a column beside it. */
const SIDE_TAKEOVER_MIN = 0.55;

const COLORS = {
  background: '#06070d',
  grid: 'rgba(120,140,190,0.055)',
  guide: 'rgba(255,255,255,0.30)',
  draft: '#e8ecff',
};


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
    // Ripples are keyed by an id rather than by their own coordinates, so two
    // ripples created in the same frame at the same place are not silently
    // collapsed into one.
    this._nextTweenId = 1;
    this.time = 0;
    this.lastFrame = null;
    this.fps = 60;
    this.reduced = Boolean(options.reducedMotion);
    this.now = options.now ?? (() => performance.now());
    // Gesture clock, separate from `now`.
    //
    // Pluck, bow and hold are judged from how fast the finger moves, so they
    // need a clock. `now` is the wrong one: it is wall time, which a test harness
    // - or a browser that stalls a frame - advances by whole seconds between two
    // pointer events, turning every careful drag into a 30,000 px/s flick. Time
    // here only ever moves in bounded steps (one per animation frame, or one per
    // stepped frame in a screenshot run), so the speed a gesture sees is the
    // speed it was drawn at.
    this.gestureClock = { ms: 0 };
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
    // Seed the instrument on the first resize that reports a real field, and
    // never re-seed it from a resize.
    //
    // Here rather than in `start()` because the first measurement of a canvas is
    // frequently wrong: a phone reports its viewport in two passes, and a
    // document loaded in a background tab reports nothing at all. Seeding from a
    // 0x0 box puts every string at a degenerate coordinate, where it stays for
    // the session.
    //
    // And *only* here, rather than on every resize, because an orientation change
    // is not a reason to throw away an instrument mid-session: it would discard
    // whatever the player had already plucked into it. A rotation translates the
    // instrument so nothing strands offscreen (`_relayout`) and never scales it -
    // length is pitch, so resizing must not retune anything.
    if (width > 0 && height > 0 && this.instrument.count === 0) this._primeDemo();
    this._relayout();
    this.render();
  }

  /**
   * Keep the instrument visible after a resize or rotation.
   *
   * The instrument is nudged back inside the free area, and the free area
   * excludes the overlays - so on a phone that turns landscape while the lesson
   * is open, the instrument would otherwise be dragged out from under a panel
   * that grew across it. The lesson is the temporary thing, so it yields.
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
    // Only the group's position moves; lengths are untouched, and length is
    // pitch - a rotation must never retune the instrument.

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

  /**
   * How far from a string a press still counts as touching it, in canvas pixels.
   * Derived from the instrument's own size so one gesture works at any viewport:
   * half the gap to the nearest parallel string, bounded below by the finger's
   * own precision and above by `HIT.grabMaxPx`.
   */
  bodyGrabPx() {
    let nearestGap = Number.POSITIVE_INFINITY;
    for (const line of this.instrument.strings) {
      const middle = line.restAt(0.5);
      for (const other of this.instrument.strings) {
        if (other === line) continue;
        // Only near-parallel strings create the ambiguity that matters; one
        // crossing at a steep angle is not confusable with this string.
        const dot = Math.abs(line.unit.x * other.unit.x + line.unit.y * other.unit.y);
        if (dot < 0.9) continue;
        const otherMiddle = other.restAt(0.5);
        nearestGap = Math.min(nearestGap, Math.hypot(otherMiddle.x - middle.x, otherMiddle.y - middle.y));
      }
    }
    if (!Number.isFinite(nearestGap)) return HIT.bodyPx;
    return Math.min(Math.max(HIT.bodyPx, nearestGap * 0.5), HIT.grabMaxPx);
  }

  /** Classify a press: an endpoint wins over the body, which wins over space. */
  _hitTest(x, y) {
    const bodyRadius = this.bodyGrabPx();
    let bestBody = null;
    let bestBodyDistance = bodyRadius;
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

  /**
   * Capture the pointer if that is possible, and never mind if it is not.
   *
   * Capture keeps the gesture alive when the finger slides off the canvas, which
   * is worth having on a phone. It is not load-bearing: a pointer id that is no
   * longer active makes the call throw, and letting that exception escape would
   * abort the rest of `_down` - so the tap would silently do nothing.
   */
  _capturePointer(event) {
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gesture time, in ms - the denominator of every finger-speed comparison.
   *
   * Derived from events rather than from wall time. A pointermove is generated
   * by the browser at most once per frame, so counting one frame's worth per
   * event puts a hard floor of `GESTURE_FRAME_MS` under any interval the app
   * could observe.
   *
   * Reading the wall clock instead makes the same drag ambiguous: delivered
   * smoothly it reads as a rub, delivered bunched - a stutter, a backgrounded
   * tab, a driver dispatching a whole drag in one task - as a violent flick.
   * Speed still drives how loudly a bow sounds; it no longer decides which
   * gesture a finger is making, which is why this clock only has to be steady
   * rather than truthful.
   *
   * Frames with no events advance the clock too, so a held or bowed string ages
   * correctly while the browser coalesces moves.
   */
  _advanceGestureClock(frames = 1) {
    this.gestureClock.ms += GESTURE_FRAME_MS * Math.max(frames, 0);
  }

  /** Release capture; mirrors `_capturePointer` in being unthrowable. */
  _releasePointer(event) {
    try {
      this.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      /* never captured, or already released */
    }
  }

  _down(event) {
    if (event.button !== undefined && event.button > 0) return;
    // A press starts a fresh gesture; the clock keeps running so the release of
    // one gesture and the press of the next are still separated by real time.
    this._advanceGestureClock();
    this._capturePointer(event);
    void this.audio.unlock().then((ok) => {
      if (this.state.audio !== (ok ? 'on' : 'off')) this._setState({ audio: ok ? 'on' : 'off' });
    });
    const point = this._point(event);
    const hit = this._hitTest(point.x, point.y);
    const gesture = {
      id: event.pointerId,
      start: point,
      last: { ...point },
      lastMove: this.gestureClock.ms,
      kind: hit.kind === Proximity.None ? 'draw' : hit.kind === Proximity.End ? 'retune' : 'touch',
      // A retune may legitimately stretch far (that is how low you can go), but
      // it must never collapse a string into noise; see the guard in _move.
      originLengthPx: hit.line ? hit.line.lengthPx : 0,
      line: hit.line,
      end: hit.end,
      createdString: false,
      moved: 0,
      startedAt: this.gestureClock.ms,
      sounded: false,
    };
    this.activeGestures.push(gesture);
    this.pointer = gesture;
    if (gesture.kind === 'draw') {
      this.drafts.set(gesture.id, { x0: point.x, y0: point.y, x1: point.x, y1: point.y, crossing: null });
      this._syncUi();
    } else if (gesture.kind === 'touch') {
      this.touchMode = TouchMode.Hold;
      hit.line.held = true;
      this._setState({ gesture: 'hold', detail: 'holding - sound damped under your finger' });
    } else {
      this._setState({ gesture: 'retune', detail: 'drag to retune' });
    }
    this._setState({ phase: Phase.Drawing });
  }

  _move(event) {
    this._advanceGestureClock();
    const gesture = this.activeGestures.find((item) => item.id === event.pointerId);
    const point = this._point(event);
    if (!gesture) {
      const hit = this._hitTest(point.x, point.y);
      this.hover = { ...hit, x: point.x, y: point.y };
      return;
    }
    const dt = Math.max(0.001, (this.gestureClock.ms - gesture.lastMove) / 1000);
    const dx = point.x - gesture.last.x;
    const dy = point.y - gesture.last.y;
    gesture.moved += Math.hypot(dx, dy);
    gesture.speed = Math.hypot(dx, dy) / dt;
    gesture.last = { ...point };
    gesture.lastMove = this.gestureClock.ms;

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
      // A limit that silently ignores the finger looks like a broken handle, so
      // it says why nothing moved instead.
      if (wanted > this.maxRetuneLengthPx()) {
        this._setState({ detail: 'as long as this screen gets' });
        return;
      }
      if (wanted < MIN_LENGTH_PX * 1.5) {
        this._setState({ detail: `as short as it goes - about ${Math.round(this._pitchForLength(MIN_LENGTH_PX * 1.5))} Hz` });
        return;
      }
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
    // Touch gesture. Rubbing *along* a string bows it; pulling *across* it
    // plucks it; staying put damps it. The decision is made from direction, not
    // from how fast: a fast straight drag along a string sounds exactly like a
    // bow to the finger that made it, and speed is the one thing a pointer
    // stream is unreliable about (bunching, dropped frames, a driver that
    // dispatches a whole drag in one task all inflate it).
    const line = gesture.line;
    const acrossPx = line.toLocal(point.x, point.y).across;
    const along = dx * line.unit.x + dy * line.unit.y;
    gesture.alongTravel = (gesture.alongTravel ?? 0) + Math.abs(along);
    gesture.offTravel = (gesture.offTravel ?? 0) + Math.abs(acrossPx - (gesture.lastAcross ?? acrossPx));
    gesture.lastAcross = acrossPx;
    // Bows one way then the other still counts: travel both ways, off one way.
    const rubbing =
      gesture.alongTravel >= HIT.bowTravelPx &&
      gesture.alongTravel > gesture.offTravel * HIT.bowAlignment &&
      Math.abs(acrossPx) <= HIT.bodyPx;
    if (rubbing) {
      this.touchMode = TouchMode.Bow;
      line.held = false;
      gesture.sounded = true;
      // The pitch while bowing, not after: a rub that is working is worth
      // confirming with the number it produces.
      this._setState({
        gesture: 'bow',
        detail: `bowing ~${Math.round(line.pitchHz())} Hz - keep rubbing to sustain`,
        pitchHz: line.pitchHz(),
      });
    } else if (this.touchMode === TouchMode.Bow) {
      this._setState({ gesture: 'bow', detail: `bowing ~${Math.round(line.pitchHz())} Hz - keep rubbing to sustain` });
    } else {
      this.touchMode = TouchMode.Hold;
      line.held = true;
      this._setState({ gesture: 'hold', detail: 'holding - sound damped under your finger' });
    }
  }

  _up(event, cancelled) {
    this._advanceGestureClock();
    const index = this.activeGestures.findIndex((item) => item.id === event.pointerId);
    if (index < 0) return;
    const gesture = this.activeGestures[index];
    this.activeGestures.splice(index, 1);
    this._releasePointer(event);
    const point = this._point(event);

    if (gesture.kind === 'draw') {
      const draft = this.drafts.get(gesture.id);
      this.drafts.delete(gesture.id);
      const length = draft ? Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0) : 0;
      if (!cancelled && length >= MIN_LENGTH_PX) {
        const line = this.instrument.add(draft.x0, draft.y0, draft.x1, draft.y1);
        if (line) {
          gesture.createdString = true;
          this._played = true;
          // The instructions have done their job once the player has made a
          // string of their own. Hook optional: the app works with no DOM.
          this.onFirstTouch?.();
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
      gesture.releasedAt = this.gestureClock.ms;
      // A gesture that bowed has already sounded continuously; ending it with a
      // pluck would cut the note short with an accent nobody asked for, so the
      // bow simply stops.
      const bowed = gesture.sounded;
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
      if (bowed) {
        // "Held" rather than "released" or "bowing": nothing was set down, and
        // the note is not sounding now, because a bow only sounds while it
        // moves. The number is the pitch it was holding.
        this._setState({
          gesture: 'none',
          detail: `held ~${Math.round(line.pitchHz())} Hz while you bowed it`,
        });
      } else if (gesture.moved >= HIT.minFlickDistancePx) {
        // Flick: pull where the finger actually left the string, as hard as the
        // release speed implies. This is the drag-across-and-let-go gesture, and
        // so is a rub: a gesture that bowed at any point is released as a pluck,
        // otherwise lifting the finger after a long slow bow would end in silence.
        pluckAt(local.along, clamp(gesture.speed / 500, 0.4, 1.5), 'plucked');
      } else if (this.gestureClock.ms - gesture.startedAt < HIT.tapMs) {
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

  /** Retune ceiling for the current field: long strings on a big screen. */
  maxRetuneLengthPx() {
    return Math.hypot(this.width, this.height) * HIT.maxRetuneLengthRatio;
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
   * Where the instrument may be drawn: the canvas not covered by permanent
   * overlay, grown as little as necessary until an instrument actually fits.
   *
   * The instrument used to be centred on the viewport, which on a portrait phone
   * put three of its four strings behind the lesson panel - the instructions said
   * "drag across a string" on top of strings nobody could see. Panels are placed
   * by CSS, so the only honest way to know where they are is to measure them.
   *
   * Permanent chrome - the wordmark, the meters, the readout, the buttons, the
   * About disclosure - always blocks. The lesson blocks while it is on screen
   * and stops the moment it is dismissed; it is not in `CHROME_SELECTOR`
   * precisely because it goes away, and by then the area a new string is
   * measured against is the one the instrument already sits in, so nothing
   * slides across the stage as the panel fades.
   *
   * The growth at the end is what makes this safe to use for placement. The
   * seeded strings go exactly where this rectangle says, so on a viewport whose
   * chrome leaves no workable room, an unchecked rectangle can collapse - and
   * the app would start with an empty stage, which is the one thing a first-time
   * visitor must never be handed.
   *
   * Returns the whole canvas when there is no DOM to measure: the layout is a
   * nicety, and the app must still run with the canvas on its own.
   */
  freeArea() {
    const margin = FREE_AREA_MARGIN_PX;
    const area = { left: margin, top: margin, right: this.width - margin, bottom: this.height - margin };
    const overlay = this.ui?.querySelectorAll?.(
      `${CHROME_SELECTOR}, ${LESSON_SELECTOR}:not([hidden])`,
    );
    // Measuring is the whole point, so what is feature-detected is the ability
    // to measure and not the presence of elements: a stub without layout has
    // panels that report no geometry, and honouring their zero-sized boxes would
    // let the chrome claim the entire canvas.
    if (!overlay) return this._growToFitInstrument(area);
    const boxes = [];
    for (const node of overlay) {
      if (node.hidden) continue;
      const box = node.getBoundingClientRect?.();
      if (box && box.width && box.height) boxes.push(box);
    }
    if (boxes.length === 0) return this._growToFitInstrument(area);

    // Bands, not individual panels: the wordmark and the meters read as one line
    // across the top, the readout and the buttons as one strip along the bottom,
    // and avoiding them singly would happily put the instrument between a caption
    // and the button it describes.
    //
    // A panel belongs to a band by which edge of the screen it is anchored to,
    // not by how tall it happens to be. Height-based rules cannot work here: the
    // lesson is pinned to the bottom in landscape and to the top in portrait, and
    // is a different height on every device, so a "tall enough to be chrome"
    // threshold would classify the same element differently on two phones. Edge
    // anchoring is what the CSS actually says about the element, which is the
    // question being asked.
    const anchored = (edge, size) =>
      boxes.filter((b) => b[edge] <= this[edge === 'top' ? 'height' : 'width'] * ANCHOR_EDGE_FRACTION)
        .filter((b) => (edge === 'top' ? b.bottom <= this.height / 2 : b.top >= this.height / 2))
        .reduce((best, b) => Math.max(best, b[size]), -Infinity);
    const anchoredBottom = (edge) =>
      boxes.filter((b) => Math.abs(b.bottom - this.height) <= this.height * ANCHOR_EDGE_FRACTION)
        .filter((b) => b.top >= this.height / 2)
        .reduce((best, b) => Math.min(best, b.top), Infinity);
    const topClaim = anchored('top', 'bottom');
    const bottomClaim = anchoredBottom('bottom');
    if (Number.isFinite(topClaim)) area.top = Math.max(area.top, topClaim + margin);
    if (Number.isFinite(bottomClaim)) area.bottom = Math.min(area.bottom, bottomClaim - margin);

    // Columns, for a panel that is tall relative to the screen and does not span
    // the whole of it: a lesson on a desktop, where there is height to spare and
    // a whole unused side of the screen to put the instrument in. Short panels
    // are bands rather than columns; treating the landscape lesson as a column
    // would squeeze the instrument into a strip down the middle of the screen.
    for (const box of boxes) {
      if (box.height < this.height * COLUMN_MIN_HEIGHT) continue;
      if (box.width >= this.width * SIDE_TAKEOVER_MIN) continue;
      if (box.left + box.width / 2 <= this.width / 2) area.left = Math.max(area.left, box.right + margin);
      else area.right = Math.min(area.right, box.left - margin);
    }

    // The lesson, which the rules above cannot classify: it is a wide panel,
    // shorter than `COLUMN_MIN_HEIGHT` on every device, so it arrives here as
    // neither a band nor a column.
    //
    // The question is what clearing it costs, and the answer is strings the
    // player can no longer see. Two attempts at a cheaper proxy for that cost
    // both went wrong in opposite directions:
    //
    //   Always honour it: the instrument loses a third of its span on desktop,
    //     where the strings are long enough to run clear past the panel's right
    //     edge and a third of them were never under it.
    //   Exempt it: portrait phones start with two of four strings behind the
    //     text, which is the first thing a new player sees.
    //
    // So measure the loss directly and pay it only when it is real. The share of
    // total string length the panel would cover is 0.22 on a desktop and on a
    // landscape phone - one row out of four, which the panel overlaps rather
    // than displacing - and 1.00 on a portrait phone, where it covers every row
    // and the instrument moves below it.
    const lesson = this.ui?.querySelector?.(LESSON_SELECTOR);
    if (lesson && !lesson.hidden) {
      const box = lesson.getBoundingClientRect?.();
      if (box && box.width && box.height && this._lessonHidesRows(area, box)) {
        // Anchored to the bottom half of the screen: grow the area upward.
        if (box.top > this.height / 2) area.bottom = Math.min(area.bottom, box.top - margin);
        else area.top = Math.max(area.top, box.bottom + margin);
      }
    }
    return this._growToFitInstrument(area);
  }

  /**
   * Whether the lesson hides enough of the instrument to be worth moving it.
   *
   * The cost is the share of total string length the panel would cover, and it
   * is computed from the same span-and-centre arithmetic `_primeDemo` uses to
   * place the rows, so the estimate is the placement rather than an
   * approximation of it. Each row is tested in both axes: a panel that crosses
   * the instrument's column at a height where the rows have already stopped is
   * hiding nothing, which is why a width-only measure is not enough.
   *
   * Both cheaper measures were tried and both are wrong on real viewports:
   *   panel width / area width gives 0.32 on a desktop, where the panel covers
   *     no string at all, and stays blind to the landscape phone where it does.
   *   pixels read off a screenshot gets it right, but only after the strings are
   *     placed, and the decision has to be made before that.
   */
  _lessonHidesRows(area, box) {
    const layout = _demoLayout(area);
    if (!layout) return false;
    let total = 0;
    let hidden = 0;
    for (const row of layout.rows) {
      total += row.length;
      const crossesY = row.y >= box.top && row.y <= box.bottom;
      if (!crossesY) continue;
      hidden += Math.max(0, Math.min(row.right, box.right) - Math.max(row.left, box.left));
    }
    if (total <= 0) return false;
    return hidden / total > LESSON_MAX_HIDDEN_SHARE;
  }

  /**
   * Grow a rectangle until the smallest playable instrument fits inside it.
   *
   * The requirement is the same span the layout will go on to compute, so the
   * guarantee and the layout cannot drift apart: `DEMO_ROWS_BOTTOM * DEMO_ASPECT`
   * is the fraction of its own span that the lowest row sits below the highest.
   * Growth is symmetric, which keeps the instrument near the middle of what
   * room there is, and bounded by the canvas - growing past the screen is not
   * growing, it is lying.
   */
  _growToFitInstrument(area) {
    const needWidth = MIN_AUDIBLE_LENGTH_PX;
    const needHeight = needWidth * DEMO_ROWS_BOTTOM * DEMO_ASPECT;
    const grow = (lo, hi, need, span, max) => {
      if (span >= need || need > max) return [lo, hi];
      const slack = max - span;
      const before = Math.min(lo, slack / 2);
      return [lo - before, hi + (slack - before)];
    };
    const [left, right] = grow(area.left, area.right, needWidth, area.right - area.left, this.width);
    const [top, bottom] = grow(area.top, area.bottom, needHeight, area.bottom - area.top, this.height);
    return { left, top, right, bottom };
  }

  /** Whether the seeded instrument fits `area`; used by the layout tests. */
  fitsIn(area) {
    const layout = _demoLayout(area);
    if (layout.span < MIN_AUDIBLE_LENGTH_PX) return false;
    return layout.rows.every((row) => row.y >= area.top && row.y <= area.bottom);
  }

  /**
   * Seed a small instrument so the first thing a visitor sees is a living scene
   * rather than an empty rectangle, laid into the free area rather than the
   * viewport, and plucked once so it is visibly moving.
   */
  _primeDemo(force = false) {
    if (!force && this.instrument.count > 0) return;
    if (force) this.instrument.clear();
    for (const row of _demoLayout(this.freeArea()).rows) {
      const line = this.instrument.add(row.left, row.y, row.right, row.y);
      if (line) line.pluck(0.3 + line.id * 0.09, 1.25, 1);
    }
    // Seeding changes the instrument, so the counts have to be retaken here.
    // They are otherwise the initial zeros until the first frame runs, which
    // leaves the page saying `strings 0` and "drag anywhere to stretch your
    // first string" over a stage that already has four.
    this._publishState();
    this._setState({ hint: 'first-touch' });
  }

  /* ------------------------------------------------------------- rendering */

  _ripple(point, hue) {
    if (this.reduced) return;
    this.tweens.set(this._nextTweenId++, {
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
  frame(timestamp, elapsedMs = undefined) {
    const previous = this.lastFrame ?? timestamp;
    const elapsed = elapsedMs ?? timestamp - previous;
    const dt = clamp(elapsed / 1000, 0.001, 1 / 30);
    this.lastFrame = timestamp;
    this._advanceGestureClock(elapsed);
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
  /** Stop the animation loop without tearing the app down. */
  stopAnimation() {
    if (this._raf) this.globalTarget.cancelAnimationFrame?.(this._raf);
    this._raf = 0;
  }

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
      const rubbing = this.touchMode === TouchMode.Bow && gesture === this.activeGestures.at(-1);
      // The frame a string is released is excluded: a pluck is already a full
      // displacement, and dragging the bow through it on the way out would put a
      // second, louder accent on the note the player just let go of.
      if (rubbing && gesture.releasedAt === undefined) {
        forces.push({
          lineId: gesture.line.id,
          kind: 'bow',
          x: gesture.last.x,
          y: gesture.last.y,
          speed: gesture.speed ?? 0,
        });
        continue;
      }
      if (gesture.line.held && gesture.releasedAt === undefined) {
        forces.push({
          lineId: gesture.line.id,
          kind: 'hold',
          x: gesture.last.x,
          y: gesture.last.y,
          speed: 0,
        });
      }
    }
    return forces;
  }

  /**
   * Draw a frame.
   *
   * Options exist for one caller: a screenshot check asking "how much of this
   * picture did the instrument draw, as opposed to the grid and the panels?". It
   * answers by repainting the same frame without the instrument and subtracting,
   * which needs three things to hold:
   *
   *  - `withoutStrings` hides the strings, drafts and cursor - everything the
   *    player drew - and leaves the scenery.
   *  - `snapshot` draws a copy of the wave field rather than the live one, so
   *    the two shots show the same instant. Without it, whatever animation
   *    happens between the screenshots would be charged to the instrument.
   *  - `hideRipples` removes them from both passes. A ripple is the sound made
   *    visible, but it fades over a second, which makes it a poor thing to bet a
   *    pixel comparison on.
   */
  render({ withoutStrings = false, snapshot = null, hideRipples = false } = {}) {
    const previous = this._renderOverride;
    this._renderOverride = { snapshot, hideRipples };
    this._hideStrings = withoutStrings;
    try {
      this._paint();
    } finally {
      this._renderOverride = previous;
      this._hideStrings = false;
    }
  }

  /**
   * Draw one frame: background, grid, ripples, strings, drafts, cursor. The
   * What to draw, and what to draw it *from*, is resolved by `render`; this is
   * the single place the canvas is painted.
   */
  _paint() {
    const ctx = this.context;
    if (!ctx || !this.width) return;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);
    this._drawGrid(ctx);
    const override = this._renderOverride ?? {};
    if (!override.hideRipples) this._drawRipples(ctx);
    if (!this._hideStrings) {
      const strings = override.snapshot ?? this.instrument.strings;
      for (const line of strings) this._drawString(ctx, line);
      for (const draft of this.drafts.values()) this._drawDraft(ctx, draft);
      this._drawCursor(ctx);
    }
  }

  /** Whether the current touch gesture is bowing this very string. */
  _isBowingLine(line) {
    if (this.touchMode !== TouchMode.Bow) return false;
    return this.activeGestures.some((gesture) => gesture.line === line);
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
    const isBowed = this._isBowingLine(line);
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

    // A bow is a different verb from a pluck, and while the finger is down the
    // string is the only thing on screen that can say so: it is held alight and
    // thicker than a plucked string of the same loudness.
    const weight = 1.6 + 3.4 * glow + (isBowed ? 1.8 : 0);
    ctx.save();
    if (isBowed) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 12;
      ctx.shadowColor = colour;
      ctx.shadowBlur = 30;
      this._tracePath(ctx, line, true);
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = weight;
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
    ctx.font = `600 11px ${FONT_STACK}`;
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
      ctx.font = `600 13px ${FONT_STACK}`;
      ctx.fillText('crossing: becomes an ordered voice', draft.x1 + 12, draft.y1 - 10);
      ctx.restore();
    } else if (!short) {
      ctx.save();
      ctx.fillStyle = 'rgba(220,230,255,0.75)';
      ctx.font = `600 13px ${FONT_STACK}`;
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
    // Only a message that says something is stamped; clearing the text is not an
    // event worth timing.
    if (patch.detail !== undefined && patch.detail !== '') this.state.detailAt = this.time;
  }

  /** Derive the readout every frame from simulation state, not from handlers. */
  _publishState() {
    // A message about a gesture describes something that has finished, so it
    // expires; what the instrument is doing now is derived below and does not.
    if (
      this.state.detail
      && this.state.gesture === 'none'
      && this.time - this.state.detailAt > HIT.messageHoldSeconds
    ) {
      this._setState({ detail: '' });
    }
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
