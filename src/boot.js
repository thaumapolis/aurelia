/**
 * Aurelia entry point. Wires the DOM to the app, then exposes a tiny global so
 * browser automation can read state without depending on internal plumbing.
 */

import { App } from './app.js';

const CANVAS_SELECTOR = '#field';
const UI_SELECTOR = '#stage';

/** Query parameters the harness and the URL both use to pin behaviour. */
function readOverrides(search) {
  const params = new URLSearchParams(search);
  const seed = params.get('seed');
  return {
    seed: seed === null ? undefined : Number(seed),
    quiet: params.get('quiet') === '1',
    noDemo: params.get('demo') === '0',
    reducedMotion: params.get('reduced') === '1',
  };
}

/**
 * A deterministic clock for screenshots and automation.
 *
 * rAF drives the simulation with a browser-supplied timestamp, so the wave field
 * after "one second" depends on how busy the machine was. Stepping by hand makes
 * frame N mean the same thing on every machine, which is the only way a golden
 * image can be compared at all. Installed unconditionally, because a testing
 * affordance that appears only under a special URL is one bad test away from
 * being unused.
 */
function installDeterministicStepping(app, { quiet }) {
  // `frame()` rather than a hand-rolled step: it keeps the app in charge of the
  // clock that pluck and bow are measured against, so a stepped run and a live
  // one agree about how fast a finger was moving.
  globalThis.__aureliaStep = (frames = 1, dt = 1 / 60) => {
    for (let i = 0; i < frames; i += 1) app.frame(dt * 1000, dt * 1000);
    return { frames, dt, time: app.time };
  };
  // Paints on demand and hands the canvas back as base64 PNG, so a check can
  // compare a frame against a repainting of itself without a second page.
  globalThis.__aureliaRender = (options = {}) => {
    app.render({
      withoutStrings: options.strings === false,
      snapshot: options.snapshot ?? null,
      hideRipples: options.hideRipples === true,
    });
    return app.canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  };
  if (quiet) app.stopAnimation();
}

function boot() {
  const canvas = document.querySelector(CANVAS_SELECTOR);
  const ui = document.querySelector(UI_SELECTOR);
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(`Aurelia needs a <canvas> matching ${CANVAS_SELECTOR}`);
  }
  const overrides = readOverrides(window.location.search);
  const app = new App(canvas, ui, {
    seed: overrides.seed,
    reducedMotion: overrides.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  });
  app.start();
  installDeterministicStepping(app, { quiet: overrides.quiet });

  const learn = document.querySelector('#learn');
  const dismissLearn = () => {
    if (!learn || learn.classList.contains('dismissed')) return;
    learn.classList.add('dismissed');
    window.setTimeout(() => learn.setAttribute('hidden', ''), 460);
  };
  // Dismissed once the player has actually made something, not on any touch.
  // A tap that mutes a string, or a drag that misses, leaves the instructions
  // where they can still be read; the first new string is the moment they stop
  // being needed. The app calls this through `onFirstTouch`.
  app.onFirstTouch = dismissLearn;
  window.addEventListener('keydown', dismissLearn, { once: true });

  const readout = document.querySelector('#readout-detail');
  const meters = {
    strings: document.querySelector('#m-strings'),
    ringing: document.querySelector('#m-ringing'),
    pitch: document.querySelector('#m-pitch'),
  };
  let previous = '';
  /** Copy the app's state onto the page. Returns whether anything changed. */
  const sync = () => {
    const state = app.state;
    const detail = state.detail || defaultDetail(state);
    const pitch = state.pitchHz ? `${Math.round(state.pitchHz)} Hz` : '-';
    const signature = `${detail}|${state.strings}|${state.sounding}|${pitch}`;
    if (signature === previous) return false;
    previous = signature;
    if (readout) readout.textContent = detail;
    if (meters.strings) meters.strings.textContent = String(state.strings);
    if (meters.ringing) meters.ringing.textContent = String(state.sounding);
    if (meters.pitch) meters.pitch.textContent = pitch;
    return true;
  };
  const paint = () => {
    sync();
    requestAnimationFrame(paint);
  };
  // Painted once before the loop starts. The seeded instrument exists by now,
  // so without this the page shows an empty stage's numbers - `strings 0`, and
  // "Drag anywhere to stretch your first string" over four strings - until the
  // first animation frame arrives. That is about 16ms on a focused tab, and
  // indefinite in a background one or under a browser that defers rAF.
  sync();
  requestAnimationFrame(paint);

  globalThis.__aurelia = {
    app,
    step: (frames, dt) => globalThis.__aureliaStep(frames, dt),
    state: () => ({ ...app.state }),
    strings: () =>
      app.instrument.strings.map((line) => ({
        id: line.id,
        lengthPx: line.lengthPx,
        pitchHz: line.pitchHz(),
        amplitude: line.amplitude(),
        generation: line.generation,
      })),
  };
  document.documentElement.dataset.aureliaReady = '1';
  return app;
}

/** What the status line says when no gesture has produced a message yet. */
function defaultDetail(state) {
  if (state.strings === 0) return 'Drag anywhere to stretch your first string';
  if (state.sounding > 0) return `${state.sounding} string${state.sounding === 1 ? '' : 's'} ringing`;
  return 'Drag across a string to pluck it';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
