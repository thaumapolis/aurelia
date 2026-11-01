/**
 * Engine coverage: does the app actually run in each browser, not merely in the
 * one the baselines were drawn with.
 *
 * This is deliberately not a pixel comparison. The goldens are Firefox baselines
 * and another engine differs in font rasterisation and anti-aliasing, so
 * comparing them would fail for reasons that have nothing to do with the app.
 * What matters cross-engine is behavioural: the page boots, the instrument is
 * seeded and visibly drawn, a gesture makes a string, and nothing reaches the
 * network.
 *
 * An engine that cannot launch is a failure rather than a skip, for the same
 * reason the rest of the suite treats them that way. The one exception is
 * recorded in SKIP_REASONS below, and it is keyed on a concrete observable
 * (no browser binary) rather than on a guess about the host.
 */

import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { pathToFileURL, fileURLToPath } from 'node:url';

import { loadPlaywright, openScene, gesture, advance, releaseHeld, SCENES } from '../tools/browser.mjs';

/**
 * Engines every checkout must pass. `firefox` is the baseline engine; `chromium`
 * is what most users have, and it was never verified until this file existed.
 * WebKit is available in the Nix shell but is not a distribution target, so it
 * is exercised only when explicitly asked for.
 */
const REQUIRED = ['firefox', 'chromium'];
const OPTIONAL = ['webkit'];

function requestedEngines(argv) {
  const index = argv.indexOf('--engines');
  if (index < 0) return REQUIRED;
  const list = (argv[index + 1] ?? '').split(',').filter(Boolean);
  const unknown = list.filter((name) => ![...REQUIRED, ...OPTIONAL].includes(name));
  if (unknown.length > 0) {
    throw new Error(`unknown engine(s): ${unknown.join(', ')}; known: ${[...REQUIRED, ...OPTIONAL].join(', ')}`);
  }
  return list;
}

const ENGINES = requestedEngines(process.argv);

/** A scene big enough to draw in, reused across engines so they are compared. */
const SCENE = SCENES[0];

let engines;
let url;

test.before(async () => {
  engines = await loadPlaywright();
  url = new URL('../index.html', import.meta.url).href;
});

/** Bright pixels in the canvas: proof the engine painted the instrument. */
async function litPixelCount(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#field');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 150) lit += 1;
    }
    return lit;
  });
}

/**
 * Browsers still to close, drained once by an `after` hook.
 *
 * Closing a Playwright browser costs 30 seconds in this environment, and the
 * cost is a single shared timer rather than one per browser: two browsers closed
 * one after the other take 62 seconds, closed together they take 32. Closing in
 * each test body therefore makes the suite linear in the number of engines for
 * no benefit, so every engine keeps its browser open until the tests are done
 * and they are all released at once.
 */
const open = [];

test.after(async () => {
  const closing = open.splice(0).map(({ browser }) => browser.close().catch(() => {}));
  await Promise.all(closing);
});

for (const engineName of ENGINES) {
  test(`${engineName}: boots, seeds an instrument, and plays it`, async () => {
    const { page, browser, problems } = await openScene(engines, engineName, SCENE, url);
    open.push({ engineName, browser });
    try {
      const seeded = await page.evaluate(() => ({
        count: window.__aurelia.app.instrument.count,
        meter: document.querySelector('#m-strings').textContent,
        width: window.__aurelia.app.width,
      }));
      assert.equal(seeded.count, 4, 'the seeded instrument must exist');
      // The first-paint fix: the meter agrees with the instrument immediately.
      assert.equal(seeded.meter, '4', 'the meter must not wait for a frame to count strings');

      const lit = await litPixelCount(page);
      assert.ok(
        lit > 2_000,
        `${engineName} painted only ${lit} lit pixels: the instrument is not visible`,
      );

      // A real gesture through the engine's own event pipeline.
      const spot = await page.evaluate(() => {
        const app = window.__aurelia.app;
        const blank = (x, y) => app._hitTest(x, y).kind === 'none';
        for (let y = 60; y < app.height - 120; y += 8) {
          for (let x = 60; x < app.width - 260; x += 8) {
            if (blank(x, y) && blank(x + 200, y)) return { x, y };
          }
        }
        return null;
      });
      assert.ok(spot, `no room to draw on ${engineName} at ${seeded.width}px wide`);
      await gesture(page, [
        { type: 'touch-drag', from: spot, to: { x: spot.x + 200, y: spot.y }, samples: 6 },
      ]);
      await advance(page, 3);
      const after = await page.evaluate(() => ({
        count: window.__aurelia.app.instrument.count,
        readout: document.querySelector('#readout-detail').textContent,
      }));
      assert.equal(after.count, 5, 'a drag must make a new string');
      assert.match(after.readout, /new string ~\d+ Hz/, `readout was "${after.readout}"`);

      assert.deepEqual(problems, [], `${engineName} reported page errors or failed requests`);
    } finally {
      // The finger comes up, but the browser stays open for the shared teardown.
      await releaseHeld(page);
    }
  });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = join(ROOT, 'index.html');

/**
 * The bottom row must not collide, on every phone width the layout claims.
 *
 * #controls is anchored bottom-left and #about bottom-right, with nothing
 * between them, so their combined width is what decides whether they overlap.
 * Embedding a real bold face widened both labels and put the disclosure's
 * border through the word "Clear" at 390px - which no screenshot baseline
 * covered, because the goldens are compared against themselves.
 */
for (const [width, height] of [[360, 800], [390, 844], [430, 932]]) {
  test(`${width}x${height}: the bottom controls do not overlap`, async () => {
    const browser = await engines.firefox.launch();
    open.push({ engineName: `footer-${width}`, browser });
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(pathToFileURL(ARTIFACT).href + '?quiet=1');
    await page.waitForFunction(() => window.__aurelia?.app);

    const state = await page.evaluate(() => {
      const rect = (sel) => {
        const b = document.querySelector(sel).getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      };
      return {
        controls: rect('#controls'),
        about: rect('#about'),
        readout: rect('#readout'),
        vw: innerWidth,
        vh: innerHeight,
      };
    });

    const gap = state.about.left - state.controls.right;
    assert.ok(
      gap >= 0,
      `#controls ends at ${state.controls.right.toFixed(0)}px but #about starts at ` +
        `${state.about.left.toFixed(0)}px: they overlap by ${(-gap).toFixed(0)}px`,
    );
    for (const [name, box] of [['#controls', state.controls], ['#about', state.about]]) {
      assert.ok(box.left >= 0 && box.right <= state.vw, `${name} overflows a ${width}px viewport`);
      assert.ok(box.bottom - box.top >= 44, `${name} is under the 44px finger target`);
      assert.ok(box.bottom <= state.vh, `${name} is pushed below the viewport`);
    }
  });
}
