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
 * A deterministic clock for golden screenshots: stepping `dt` by hand makes the
 * wave field identical pixel-for-pixel across machines and runs.
 */
function installScriptedFrameLoop(app) {
  let pending = null;
  globalThis.__aureliaStep = (frames = 1, dt = 1 / 60) => {
    for (let i = 0; i < frames; i += 1) {
      app.instrument.step(dt, []);
      app.render();
    }
    return { frames, dt, time: app.time };
  };
  globalThis.__aureliaRender = () => app.render();
  return pending;
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
  if (overrides.quiet) installScriptedFrameLoop(app);

  const learn = document.querySelector('#learn');
  const dismissLearn = () => {
    if (!learn || learn.classList.contains('dismissed')) return;
    learn.classList.add('dismissed');
    window.setTimeout(() => learn.setAttribute('hidden', ''), 460);
  };
  canvas.addEventListener('pointerdown', dismissLearn, { once: false });
  window.addEventListener('keydown', dismissLearn, { once: true });

  const readout = document.querySelector('#readout-detail');
  const meters = {
    strings: document.querySelector('#m-strings'),
    ringing: document.querySelector('#m-ringing'),
    pitch: document.querySelector('#m-pitch'),
  };
  let previous = '';
  const paint = () => {
    const state = app.state;
    const detail = state.detail || defaultDetail(state);
    const pitch = state.pitchHz ? `${Math.round(state.pitchHz)} Hz` : '-';
    const signature = `${detail}|${state.strings}|${state.sounding}|${pitch}`;
    if (signature !== previous) {
      previous = signature;
      if (readout) readout.textContent = detail;
      if (meters.strings) meters.strings.textContent = String(state.strings);
      if (meters.ringing) meters.ringing.textContent = String(state.sounding);
      if (meters.pitch) meters.pitch.textContent = pitch;
    }
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);

  globalThis.__aurelia = {
    app,
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
