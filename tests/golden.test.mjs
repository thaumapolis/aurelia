#!/usr/bin/env node
/**
 * Golden screenshot tests.
 *
 * Each scene is a state a real player would see, reached by real gestures, and
 * rendered deterministically: the page exposes __aureliaStep so the simulation
 * is advanced by frame count rather than by wall-clock, and the reduced-motion
 * context stops decorative animation. A golden is accepted only by a human
 * looking at it, so `--update` writes candidates and this script never
 * silently replaces a baseline it disagrees with.
 *
 *   node tests/golden.test.mjs            compare against tests/golden/
 *   node tests/golden.test.mjs --update   write new baselines
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadPlaywright,
  openScene,
  advance,
  gesture,
  releaseHeld,
  SCENES,
  DEFAULT_ENGINE,
} from '../tools/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(ROOT, 'tests', 'golden');
const DIFF_DIR = join(ROOT, '.tmp', 'golden-actual');
const ARTIFACT = join(ROOT, 'index.html');

// Fraction of pixels allowed to differ before a scene fails. Small because the
// scenes are deterministic; nonzero because text antialiasing is not byte-exact
// across driver revisions.
const TOLERANCE_RATIO = 0.0025;

const UPDATE = process.argv.includes('--update');

/** Frames of evolution after reset, so every scene begins in the same state. */
const RESET_FRAMES = 24;

/**
 * Fraction of the frame the instrument itself must draw.
 *
 * Measured against a redraw of the same frame with no strings, so the number is
 * the glow and the thread and nothing else: a lit pixel here is a string. Four
 * strings, each with a wide glow stroke, cover well over this when they exist,
 * and exactly zero when rendering is broken.
 */
const MIN_INSTRUMENT_COVERAGE = 0.004;

/** Which engine to paint with; see tools/browser.mjs for why Firefox is default. */
function engineFromArgv(argv) {
  const index = argv.indexOf('--engine');
  if (index < 0) return DEFAULT_ENGINE;
  const value = argv[index + 1];
  if (!['firefox', 'chromium', 'webkit'].includes(value)) {
    throw new Error(`--engine expects firefox, chromium or webkit, got "${value ?? ''}"`);
  }
  return value;
}

const ENGINE = engineFromArgv(process.argv);

/**
 * Scenes under test. `steps` are the gestures, `frames` how far to advance the
 * simulation afterwards so the wave has visibly moved, and `expect` is the
 * observable behaviour that must hold for the picture to mean anything - a
 * screenshot of a broken app still looks like a picture.
 */
/**
 * Gesture anchors are named positions on the instrument rather than coordinates.
 *
 * The instrument is laid out from the viewport, so "the middle of the second
 * string" is a different pixel everywhere; resolving it in the page, from the
 * same geometry the hit test uses, means a gesture keeps pointing at the thing it
 * means to point at on a 1280px desktop and on a 390px phone alike.
 */
async function resolveAnchors(page) {
  return page.evaluate(() => {
    const strings = globalThis.__aurelia.app.instrument.strings;
    const at = (index, t = 0.5) => {
      const point = strings[index].restAt(t);
      return { x: Math.round(point.x), y: Math.round(point.y) };
    };
    return {
      string0: at(0),
      string0Start: at(0, 0),
      string1: at(1),
      string2: at(2),
      string3: at(3),
      // A spot with no string within a body-grab radius, computed the same way
      // the hit test does rather than by eye: a "blank" corner that happens to
      // sit inside a generous grab radius starts a touch gesture, not a stroke,
      // and the scene silently tests the wrong verb.
      empty: (() => {
        const app = globalThis.__aurelia.app;
        const reach = app.bodyGrabPx();
        for (const [fx, fy] of [[0.08, 0.06], [0.92, 0.06], [0.08, 0.94], [0.92, 0.94], [0.5, 0.05], [0.5, 0.95]]) {
          const x = Math.round(app.width * fx);
          const y = Math.round(app.height * fy);
          if (app._hitTest(x, y).kind === 'none') return { x, y };
        }
        throw new Error('no blank space large enough to draw a new string');
      })(),
    };
  });
}

/**
 * Replace `{ anchor: 'string1' }` descriptors with pixel coordinates.
 *
 * A step says where it begins (`from`) and either an absolute `to` or a
 * relative `offset`; both ends must come back as numbers, because the driver
 * dispatches raw client coordinates. A name that does not resolve is an error
 * rather than a silently dropped gesture - every scene would then "pass" with
 * the instrument sitting untouched.
 */
function bindSteps(steps, anchors) {
  const pointOf = (spec) => {
    if (!spec) return undefined;
    const point = spec.anchor ? anchors[spec.anchor] : spec;
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
      throw new Error(`gesture anchor "${spec.anchor ?? '?'}" did not resolve to a point`);
    }
    return point;
  };
  return steps.map((step) => {
    if (step.type === 'wait') return step;
    const from = pointOf(step.from);
    const to = step.offset ? { x: from.x + step.offset.x, y: from.y + step.offset.y } : pointOf(step.to);
    return { ...step, from, to };
  });
}

const CASES = [
  {
    name: 'onboarding',
    description: 'first paint: the three verbs, and a string still moving',
    steps: [],
    frames: 30,
    expect: { minStrings: 3, minRinging: 1 },
    requireOnscreen: true,
    // Enough of the instrument has to be visible, beside the panel, for the
    // panel to be about something the player can act on: two strings means one
    // to pluck and one to pluck in answer. The panel may overlap the rest - on a
    // landscape phone that is the only honest trade - so this counts strings
    // that are clear of it rather than demanding none are under it.
    minStringsClearOfPanel: 2,
  },
  {
    name: 'ringing',
    description: 'onboarding dismissed, all four strings sounding',
    steps: [],
    frames: 20,
    expect: { minStrings: 3, minRinging: 2 },
  },
  {
    name: 'pluck',
    description: 'a fresh pluck mid-string: bright glow and a visible bend',
    steps: [{ type: 'touch-drag', from: { anchor: 'string1' }, offset: { x: 0, y: 26 }, samples: 6 }],
    frames: 5,
    expect: { minStrings: 3, minRinging: 1 },
    expectDetail: /plucked ~\d+ Hz/,
  },
  {
    name: 'draw',
    description: 'a new string drawn in empty space, announced with its pitch',
    steps: [
      // Start well clear of every string, then stretch a long one: a short drag
      // would be read as a tap somewhere else on the instrument.
      { type: 'touch-drag', from: { anchor: 'empty' }, offset: { x: 240, y: 30 }, samples: 12 },
    ],
    frames: 4,
    expect: { minStrings: 4 },
    expectDetail: /new string ~\d+ Hz/,
  },
  {
    name: 'bowed',
    description: 'a bowed string: sustained, and smoother than a pluck',
    // Rub along the string's own length: the gesture is horizontal by definition,
    // so the offset is a fixed horizontal sweep rather than a second anchor.
    steps: [
      // Held at the end of the rub rather than released: a bowed string decays
      // within a few frames of letting go, so the picture of bowing is the shape
      // during the bow, and so is the message the bow reports while it moves.
      { type: 'touch-drag', from: { anchor: 'string2' }, offset: { x: 150, y: 0 }, samples: 24, hold: true },
    ],
    frames: 0,
    expect: { minStrings: 3, minRinging: 1 },
    expectDetail: /bowing ~\d+ Hz/,
  },
  {
    name: 'retuned',
    description: 'after dragging a tuning handle: the readout names the change',
    steps: [{ type: 'touch-drag', from: { anchor: 'string0Start' }, offset: { x: 120, y: 0 }, samples: 14 }],
    frames: 8,
    expect: { minStrings: 3 },
    expectDetail: /retuning \d+ Hz -> \d+ Hz/,
  },
];

/* ------------------------------------------------------------- PNG decoding */
/*
 * PNG is decoded with zlib rather than a library: the store has no pngjs on
 * Node's module path, and adding a vendored dependency to check pictures is
 * more machinery than the ~40 lines it replaces.
 */
import { inflateSync } from 'node:zlib';

function decodePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== signature[i]) throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height) throw new Error('PNG missing IHDR');
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`colour type ${colorType} unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    unfilter(filterType, line, previous, out, channels);
    previous = out;
  }
  return { width, height, channels, data: pixels };
}

function unfilter(filterType, line, previous, out, channels) {
  for (let i = 0; i < line.length; i += 1) {
    const a = i >= channels ? out[i - channels] : 0;
    const b = previous[i] ?? 0;
    const c = i >= channels ? previous[i - channels] : 0;
    let value = line[i];
    if (filterType === 1) value += a;
    else if (filterType === 2) value += b;
    else if (filterType === 3) value += (a + b) >> 1;
    else if (filterType === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    } else if (filterType !== 0) {
      throw new Error(`unknown PNG filter ${filterType}`);
    }
    out[i] = value & 0xff;
  }
}

/** Count pixels differing by more than a small threshold. */
function compareImages(actual, expected) {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return { ratio: 1, detail: `size changed: ${actual.width}x${actual.height} vs ${expected.width}x${expected.height}` };
  }
  let different = 0;
  const perPixel = actual.channels;
  const total = actual.width * actual.height;
  for (let i = 0; i < total; i += 1) {
    let maxDelta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(actual.data[i * perPixel + channel] - expected.data[i * perPixel + channel]);
      if (delta > maxDelta) maxDelta = delta;
    }
    // Threshold per channel: a single quantum of rounding on an antialiased text
    // edge should not fail a run, but a changed colour or a moved glyph will.
    if (maxDelta > 8) different += 1;
  }
  return { ratio: different / total, detail: `${different} of ${total} pixels differ` };
}

/** Fraction of pixels that are not near-black: catches a blank canvas. */
function inkCoverage(image) {
  let lit = 0;
  const total = image.width * image.height;
  const step = image.channels;
  for (let i = 0; i < total; i += 1) {
    const base = i * step;
    const luminance = image.data[base] * 0.299 + image.data[base + 1] * 0.587 + image.data[base + 2] * 0.114;
    if (luminance > 40) lit += 1;
  }
  return lit / total;
}

/* ------------------------------------------------------------------- runner */

async function main() {
  const failures = [];
  let compared = 0;
  let written = 0;

  if (!existsSync(ARTIFACT)) {
    throw new Error(`${ARTIFACT} does not exist. Run the build first: node tools/build.mjs`);
  }
  // A file:// URL with a query string is how the artifact is loaded, so the page
  // can read its own options; some engines are fussy about queries on file URLs,
  // so the driver passes the artifact path and the scene opts in through it.
  // `quiet=1` stops the app's own animation loop. Without it, rAF keeps running
  // in the background while the harness steps frames by hand, so two clocks
  // advance the same simulation and the frame that gets photographed depends on
  // how busy the machine was - which is not a flaky test so much as a test of
  // nothing. The app's `time` visibly drifts between identical runs (0.7246 vs
  // 0.8754 over four rounds) before this is switched on.
  const url = `${pathToFileURL(ARTIFACT).href}?quiet=1`;
  mkdirSync(DIFF_DIR, { recursive: true });
  mkdirSync(GOLDEN_DIR, { recursive: true });

  const engines = await loadPlaywright();
  console.log(`engine: ${ENGINE}`);

  for (const scene of SCENES) {
    const { browser, page, problems } = await openScene(engines, ENGINE, scene, url);
    try {
      for (const testCase of CASES) {
        const label = `${scene.name}/${testCase.name}`;
        // Every scene starts from the same live instrument.
        //
        // The order here is the point: prime, then pluck, then advance. A
        // golden that shows an instrument at absolute rest is a photograph of
        // nothing, so each scene begins with energy in it and moves forward a
        // fixed number of frames to a state that is identical run to run.
        await releaseHeld(page);
        await page.evaluate(() => {
          const app = globalThis.__aurelia.app;
          app.tweens.clear();
          app.hover = null;
          app.activeGestures.length = 0;
          app.drafts.clear();
          app.instrument.clear();
          app._primeDemo(true);
          app._setState({ hint: 'first-touch', detail: '', gesture: 'none', pitchHz: null });
          for (const [index, line] of app.instrument.strings.entries()) {
            line.u.fill(0);
            line.v.fill(0);
            line.pluck(0.28 + index * 0.13, 1.15, 1);
          }
        });
        await advance(page, RESET_FRAMES);
        const settled = await page.evaluate(() => globalThis.__aurelia.state());
        if (settled.sounding < 1) {
          throw new Error(`reset left ${settled.sounding} strings sounding; goldens need a live instrument`);
        }
        if (testCase.name !== 'onboarding') {
          await page.evaluate(() => {
            const learn = document.querySelector('#learn');
            if (learn) {
              learn.classList.add('dismissed');
              learn.setAttribute('hidden', '');
            }
          });
        }

        // A scene that ends with a finger still on the screen has to lift it
        // again afterwards, or the next scene inherits a stranger's gesture.
        // Anchors are resolved after the reset, not once per scene: a gesture
        // can add a string, and the reset that follows takes it away again.
        await gesture(page, bindSteps(testCase.steps, await resolveAnchors(page)));
        await advance(page, testCase.frames);

        const state = await page.evaluate(() => globalThis.__aurelia.state());
        const shot = await page.screenshot({ type: 'png' });
        const path = join(scene.name === 'desktop' ? GOLDEN_DIR : GOLDEN_DIR, `${scene.name}-${testCase.name}.png`);
        const actualPath = join(DIFF_DIR, `${scene.name}-${testCase.name}.png`);
        writeFileSync(actualPath, shot);

        const problemsHere = [...problems];
        if (testCase.expect) {
          const expectation = testCase.expect;
          if (expectation.strings !== undefined && state.strings !== expectation.strings) {
            problemsHere.push(`strings: expected ${expectation.strings}, got ${state.strings}`);
          }
          if (expectation.minStrings !== undefined && state.strings < expectation.minStrings) {
            problemsHere.push(`strings: expected >=${expectation.minStrings}, got ${state.strings}`);
          }
          if (expectation.minRinging !== undefined && state.sounding < expectation.minRinging) {
            problemsHere.push(`ringing: expected >=${expectation.minRinging}, got ${state.sounding}`);
          }
        }
        if (testCase.minStringsClearOfPanel !== undefined) {
          const view = await page.evaluate(() => {
            const app = globalThis.__aurelia.app;
            const panel = document.querySelector('#learn');
            if (!panel || panel.hidden) return null;
            const box = panel.getBoundingClientRect();
            const outside = (point) =>
              point.x < box.left || point.x > box.right || point.y < box.top || point.y > box.bottom;
            // A string counts as clear when its whole length is outside the
            // panel; one that runs through it is only readable where it peeks
            // out, which is not something to aim a finger at.
            const clear = app.instrument.strings.filter((line) =>
              [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].every((t) => outside(line.restAt(t))),
            ).length;
            return { clear, panel: `${Math.round(box.width)}x${Math.round(box.height)} at y${Math.round(box.top)}` };
          });
          if (view && view.clear < testCase.minStringsClearOfPanel) {
            problemsHere.push(
              `only ${view.clear} string(s) are clear of the lesson panel (needs ${testCase.minStringsClearOfPanel}; panel ${view.panel})`,
            );
          }
        }
        if (testCase.expectDetail && !testCase.expectDetail.test(state.detail)) {
          problemsHere.push(`detail "${state.detail}" does not match ${testCase.expectDetail}`);
        }

        const image = decodePng(shot);
        // How much of the frame the instrument itself drew.
        //
        // Answered relative to the scene rather than against a magic number: the
        // static grid and panel text are already a couple of percent of lit
        // pixels, which tells you nothing about whether a string is on screen.
        // So the same frame is repainted with the instrument hidden and the two
        // are subtracted, and only light the strings produced is left.
        //
        // The override takes an explicit snapshot of the wave field, because
        // these are two separate screenshots: a repaint that reads live state
        // would differ from the frame being measured, and the difference would
        // be blamed on the instrument.
        //
        // Ripples are excluded from *both* passes. They are the sound made
        // visible - emitted by the pluck - but they fade over a second, so they
        // are a poor thing to bet a baseline on; the strings themselves are what
        // has to be provably present.
        // The snapshot is the wave field exactly as the shot above saw it, and
        // the transient UI - a finger still resting on the instrument, an
        // in-progress stroke - is cleared for the same reason. Both belong to
        // the player's ink; showing them in one pass and not the other would
        // invent a difference and charge it to the strings.
        const bareShot = await page.evaluate(() => {
          const app = globalThis.__aurelia.app;
          const snapshot = app.instrument.strings.map((line) => line.cloneForDisplay());
          const gestures = app.activeGestures.slice();
          const drafts = new Map(app.drafts);
          const hover = app.hover;
          app.activeGestures.length = 0;
          app.drafts.clear();
          app.hover = null;
          try {
            return globalThis.__aureliaRender({ strings: false, snapshot, hideRipples: true });
          } finally {
            for (const gesture of gestures) app.activeGestures.push(gesture);
            for (const [key, draft] of drafts) app.drafts.set(key, draft);
            app.hover = hover;
          }
        });
        const coverage = inkCoverage(image);
        const chromeCoverage = inkCoverage(decodePng(Buffer.from(bareShot, 'base64')));
        const instrumentCoverage = coverage - chromeCoverage;
        if (instrumentCoverage < MIN_INSTRUMENT_COVERAGE) {
          problemsHere.push(
            `the instrument drew almost nothing: ${(instrumentCoverage * 100).toFixed(2)}% of pixels beyond the static scene ` +
              `(needs ${MIN_INSTRUMENT_COVERAGE * 100}%; frame ${(coverage * 100).toFixed(1)}%, background ${(chromeCoverage * 100).toFixed(1)}%)`,
          );
        }

        if (UPDATE || !existsSync(path)) {
          writeFileSync(path, shot);
          written += 1;
          console.log(`wrote  ${label}  (${(coverage * 100).toFixed(1)}% lit)${UPDATE ? '' : '  [new baseline]'}`);
          if (problemsHere.length > 0) failures.push(`${label}: ${problemsHere.join('; ')}`);
        } else {
          const verdict = compareImages(image, decodePng(readFileSync(path)));
          compared += 1;
          const ok = verdict.ratio <= TOLERANCE_RATIO && problemsHere.length === 0;
          console.log(`${ok ? 'ok    ' : 'FAIL  '} ${label}  ${(verdict.ratio * 100).toFixed(3)}% differ  ${verdict.detail}`);
          if (!ok) {
            failures.push(`${label}: ${(verdict.ratio * 100).toFixed(3)}% differ; ${problemsHere.join('; ')}`);
          }
        }
      }
    } finally {
      await browser.close();
    }
  }

  console.log('');
  if (written > 0) {
    console.log(`${written} baseline(s) written to ${GOLDEN_DIR}`);
    console.log('Look at every new baseline before committing it.');
  }
  if (failures.length > 0) {
    console.log(`${failures.length} golden failure(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    console.log(`Actual frames are in ${DIFF_DIR} for comparison.`);
    process.exit(1);
  }
  console.log(`goldens ok: ${compared} compared, ${written} written`);
  if (compared === 0 && written === 0) {
    console.error('no goldens were compared or written, so nothing was verified');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`golden checks failed: ${error.message}`);
  process.exit(1);
});
