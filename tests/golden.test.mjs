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

import { loadPlaywright, openScene, advance, gesture, SCENES } from '../tools/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(ROOT, 'tests', 'golden');
const DIFF_DIR = join(ROOT, '.tmp', 'golden-actual');
const ARTIFACT = join(ROOT, 'index.html');

// Fraction of pixels allowed to differ before a scene fails. Small because the
// scenes are deterministic; nonzero because text antialiasing is not byte-exact
// across driver revisions.
const TOLERANCE_RATIO = 0.0025;

const UPDATE = process.argv.includes('--update');

/**
 * Scenes under test. `steps` are the gestures, `frames` how far to advance the
 * simulation afterwards so the wave has visibly moved, and `expect` is the
 * observable behaviour that must hold for the picture to mean anything - a
 * screenshot of a broken app still looks like a picture.
 */
const CASES = [
  {
    name: 'onboarding',
    description: 'first paint: the three verbs and a moving instrument',
    steps: [],
    frames: 30,
    expect: { strings: 4, minRinging: 1 },
  },
  {
    name: 'ringing',
    description: 'onboarding dismissed, all four strings sounding',
    steps: [{ type: 'touch-drag', from: { x: 195, y: 300 }, to: { x: 196, y: 302 }, samples: 2 }],
    frames: 12,
    expect: { strings: 4, minRinging: 3 },
  },
  {
    name: 'pluck',
    description: 'a fresh pluck mid-string: bright glow and a wide bend',
    steps: [
      { type: 'touch-drag', from: { x: 195, y: 300 }, to: { x: 195, y: 296 }, samples: 2 },
      { type: 'wait', frames: 4 },
    ],
    frames: 6,
    expect: { strings: 4, minRinging: 1 },
  },
  {
    name: 'draw',
    description: 'a new string mid-drag with its pitch previewed',
    steps: [{ type: 'touch-drag', from: { x: 90, y: 150 }, to: { x: 300, y: 175 }, samples: 12 }],
    frames: 4,
    expect: { minStrings: 5 },
    // The drag ends with the pointer up, so the string exists and rings.
    expectDetail: /~\d+ Hz|new string/,
  },
  {
    name: 'bowed',
    description: 'a bowed string: sustained, smoother waveform than a pluck',
    steps: [{ type: 'touch-drag', from: { x: 120, y: 470 }, to: { x: 280, y: 478 }, samples: 26 }],
    frames: 20,
    expect: { strings: 4, minRinging: 1 },
  },
  {
    name: 'retuned',
    description: 'after dragging a tuning handle: the readout names the change',
    steps: [{ type: 'touch-drag', from: { x: 24, y: 253 }, to: { x: 174, y: 253 }, samples: 14 }],
    frames: 8,
    expect: { strings: 4 },
  },
];

/**
 * Gesture coordinates are expressed for phone-portrait (390x844) and scaled to
 * the scene, so one description of an interaction drives every viewport.
 */
function scaleSteps(steps, scene) {
  const k = Math.min(scene.width / 390, scene.height / 844);
  const scale = (point) => ({ x: Math.round(point.x * k), y: Math.round(point.y * k) });
  return steps.map((step) => ({
    ...step,
    from: step.from ? scale(step.from) : undefined,
    to: step.to ? scale(step.to) : undefined,
    path: step.path?.map(scale),
  }));
}

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
  mkdirSync(DIFF_DIR, { recursive: true });
  mkdirSync(GOLDEN_DIR, { recursive: true });

  const chromium = await loadPlaywright();
  const url = pathToFileURL(ARTIFACT).href;

  for (const scene of SCENES) {
    const { browser, page, problems } = await openScene(chromium, scene, url);
    try {
      for (const testCase of CASES) {
        const label = `${scene.name}/${testCase.name}`;
        // Reset between scenes so each golden starts from the same instrument.
        await page.evaluate(() => {
          const app = globalThis.__aurelia.app;
          app.instrument.clear();
          app._primeDemo(true);
          for (const line of app.instrument.strings) {
            line.u.fill(0);
            line.v.fill(0);
          }
          app._setState({ hint: 'first-touch', detail: '', gesture: 'none', pitchHz: null });
        });
        if (testCase.name !== 'onboarding') {
          await page.evaluate(() => {
            const learn = document.querySelector('#learn');
            if (learn) {
              learn.classList.add('dismissed');
              learn.setAttribute('hidden', '');
            }
          });
        }

        await gesture(page, scaleSteps(testCase.steps, scene));
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
        if (testCase.expectDetail && !testCase.expectDetail.test(state.detail)) {
          problemsHere.push(`detail "${state.detail}" does not match ${testCase.expectDetail}`);
        }

        const image = decodePng(shot);
        const coverage = inkCoverage(image);
        // A nearly empty frame means the canvas painted nothing worth looking at.
        if (coverage < 0.02) problemsHere.push(`frame is almost blank: only ${(coverage * 100).toFixed(1)}% of pixels lit`);

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
