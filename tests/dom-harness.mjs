/**
 * A browser surface, deliberately minimal: enough Canvas2D, DOM and PointerEvent
 * plumbing to boot src/app.js and drive it the way a finger would. This is not a
 * substitute for the Playwright goldens; it exists so the gesture/state machine
 * can be tested without a browser, which the sandbox cannot always provide.
 *
 * Recording: every canvas call becomes a text op, and `pathGeometry` measures a
 * recorded path so tests can assert a string actually bent on screen.
 */

import { App } from '../src/app.js';

export function createCanvas() {
  const ops = [];
  const state = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, shadowBlur: 0, font: '', textAlign: '', textBaseline: '', lineCap: '' };
  let pending = [];
  const ctx = {
    ops,
    currentPath: () => pending,
  };
  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (value) => {
        state[key] = value;
        ops.push({ op: `set:${key}`, value });
      },
    });
  }
  ctx.moveTo = (x, y) => {
    pending.push([x, y]);
    ops.push({ op: 'moveTo', x, y });
  };
  ctx.lineTo = (x, y) => {
    pending.push([x, y]);
    ops.push({ op: 'lineTo', x, y, strokeStyle: state.strokeStyle, lineWidth: state.lineWidth, alpha: state.globalAlpha });
  };
  ctx.arc = (x, y, radius) => {
    ops.push({ op: 'arc', x, y, radius, strokeStyle: state.strokeStyle, fillStyle: state.fillStyle, alpha: state.globalAlpha });
    ops.push({ op: 'arcPath', x, y, radius });
  };
  ctx.fill = () => ops.push({ op: 'fill', fillStyle: state.fillStyle });
  ctx.stroke = () => {
    for (const point of pending) void point;
    ops.push({ op: 'stroke', strokeStyle: state.strokeStyle, lineWidth: state.lineWidth, points: pending.length });
    pending = [];
  };
  ctx.fillRect = (x, y, width, height) => ops.push({ op: 'fillRect', x, y, width, height, fillStyle: state.fillStyle });
  ctx.fillText = (text, x, y) => ops.push({ op: 'fillText', text, x, y });
  ctx.closePath = () => {};
  ctx.beginPath = () => {
    pending = [];
    ops.push({ op: 'beginPath' });
  };
  ctx.save = () => ops.push({ op: 'save' });
  ctx.restore = () => ops.push({ op: 'restore' });
  ctx.setTransform = () => {};
  ctx.setLineDash = () => {};
  return {
    tagName: 'CANVAS',
    width: 0,
    height: 0,
    style: {},
    dataset: {},
    listeners: new Map(),
    parentElement: null,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler);
    },
    dispatch(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    },
    _ops: ops,
    _ctx: ctx,
  };
}

/** Minimal element for the UI overlay so querySelector('[data-action=...]') works. */
export function createUi() {
  const make = (action) => ({
    tagName: 'BUTTON',
    textContent: '',
    attributes: {},
    dataset: {},
    listeners: new Map(),
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler);
    },
    click() {
      for (const handler of this.listeners.get('click') ?? []) handler({});
    },
  });
  const buttons = { mute: make('mute'), clear: make('clear'), audio: make('audio') };
  return {
    buttons,
    querySelector(selector) {
      const match = /^\[data-action=(\w+)\]$/.exec(selector);
      if (match) return buttons[match[1]] ?? null;
      return null;
    },
  };
}

/** A clock the test advances by hand, so timing never depends on wall time. */
export function createClock(start = 1_000_000) {
  const clock = { now: start };
  return {
    clock,
    now: () => clock.now,
    advance: (ms) => {
      clock.now += ms;
    },
  };
}

/** Fake AudioContext that records parameter writes like the unit probe did. */
export function createAudioContextStub(record) {
  const param = (name, owner) => ({
    value: 0,
    setTargetAtTime(value) {
      record.push(`${owner}.${name}=${value.toFixed(4)}`);
      return this;
    },
  });
  const node = (kind, id, extra = {}) => ({
    kind,
    connect() {},
    disconnect() {},
    ...extra,
    gain: param('gain', `${kind}#${id}`),
  });
  let counter = 0;
  return class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = node('destination', 'dst');
    }
    createGain() {
      counter += 1;
      return node('gain', counter);
    }
    createOscillator() {
      counter += 1;
      const oscillator = node('oscillator', counter, { type: 'sine', frequency: param('frequency', `osc#${counter}`) });
      oscillator.start = () => record.push(`osc#${counter}.start`);
      oscillator.stop = () => record.push(`osc#${counter}.stop`);
      return oscillator;
    }
    createDynamicsCompressor() {
      const compressor = node('compressor', counter);
      compressor.threshold = param('threshold', 'comp');
      compressor.knee = param('knee', 'comp');
      compressor.ratio = param('ratio', 'comp');
      return compressor;
    }
    async resume() {
      this.state = 'running';
      record.push('context.resume');
    }
    close() {
      record.push('context.close');
    }
  };
}

/**
 * Boot an App against the stubs. Returns the app plus helpers that synthesise
 * pointer events, so a test reads like a list of finger movements.
 */
export function bootApp({ seed = 4242, width = 1280, height = 800, audio = true } = {}) {
  const canvas = createCanvas();
  const ui = createUi();
  const { clock, now, advance } = createClock();
  // The app attaches keyboard/resize listeners here; tests dispatch to it so
  // shortcuts can be exercised without a real window.
  const listeners = new Map();
  const globalTarget = {
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  const audioRecord = [];
  const AudioContextCtor = audio ? createAudioContextStub(audioRecord) : undefined;
  // The app sizes itself from its parent element, so the stub parent reports the
  // viewport the test asked for and `start()` computes width/height from it.
  Object.defineProperty(canvas, 'parentElement', {
    value: { getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }) },
    writable: true,
  });
  const app = new App(canvas, ui, { seed, now: () => now(), AudioContextCtor, globalTarget });
  app.start();
  const events = [];
  const send = (type, x, y, { pointerId = 1, button = 0, cancelled = false } = {}) => {
    events.push({ type, x, y, pointerId });
    canvas.dispatch(type, {
      pointerId,
      button,
      clientX: x,
      clientY: y,
      bubbles: true,
      preventDefault() {},
    });
    if (cancelled) canvas.dispatch('pointercancel', { pointerId, clientX: x, clientY: y });
  };
  const step = (frames = 1, dt = 1 / 60) => {
    for (let i = 0; i < frames; i += 1) {
      advance(dt * 1000);
      app.frame(now());
    }
  };
  const drag = (from, to, { steps = 8, ...rest } = {}) => {
    send('pointerdown', from.x, from.y, rest);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      advance(1000 / 60);
      send('pointermove', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, rest);
    }
    send('pointerup', to.x, to.y, rest);
  };
  return { app, canvas, ui, clock, advance, send, step, drag, audioRecord, events, globalTarget };
}

/** Perpendicular spread of a recorded polyline, in canvas pixels. */
export function pathBend(ops, { strokeStyleIncludes = 'hsl' } = {}) {
  const strokes = ops.filter((op) => op.op === 'stroke' && String(op.strokeStyle).includes(strokeStyleIncludes));
  return strokes.map((stroke) => stroke.points).filter((points) => points > 2);
}

/** Ops that drew the given text, so tests can assert on-screen labels. */
export function drawnText(ops) {
  return ops.filter((op) => op.op === 'fillText').map((op) => op.text);
}
