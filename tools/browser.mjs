#!/usr/bin/env node
/**
 * Browser driver: Playwright resolution, browser launch, and one place where
 * "the browser could not run" becomes a loud failure.
 *
 * Playwright is not vendored here. It is resolved from PLAYWRIGHT_ENTRY, an
 * absolute path provided by the Nix shell, because ESM does not consult
 * NODE_PATH. Everything the checks need therefore comes from one env var, and
 * its absence is an error rather than a skip: a suite that reports success after
 * painting zero pages is worse than one that errors.
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_ENV = ['PLAYWRIGHT_ENTRY', 'PLAYWRIGHT_BROWSERS_PATH'];

function missingEnv() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

export async function loadPlaywright() {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `browser checks need ${missing.join(' and ')}. Run inside the project shell:\n` +
        '  nix-shell shell.nix --run ./check.sh',
    );
  }
  const entry = process.env.PLAYWRIGHT_ENTRY;
  if (!existsSync(entry)) {
    throw new Error(`PLAYWRIGHT_ENTRY points at a file that does not exist: ${entry}`);
  }
  const module = await import(pathToFileURL(entry).href);
  const chromium = module.chromium ?? module.default?.chromium;
  if (!chromium) throw new Error(`${entry} does not export chromium`);
  return chromium;
}

/** Viewports under test: desktop, portrait phone, landscape phone. */
export const SCENES = [
  { name: 'desktop', width: 1280, height: 800, device: false, orientation: 'landscape' },
  { name: 'phone-portrait', width: 390, height: 844, device: true, orientation: 'portrait' },
  { name: 'phone-landscape', width: 844, height: 390, device: true, orientation: 'landscape' },
];

export async function openScene(chromium, scene, url) {
  const browser = await chromium.launch({
    // Chromium's own sandbox needs user-namespace syscalls that are unavailable
    // in the environments these checks run in; the page itself is local and
    // untrusted-input-free, so this is about the harness, not the app.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: scene.device ? 2 : 1,
    isMobile: scene.device,
    hasTouch: scene.device,
    reducedMotion: 'reduce',
    // Freeze animation so a screenshot of frame N is the same image on any
    // machine; the test drives the simulation by stepping it explicitly.
    timezoneId: 'UTC',
    locale: 'en-GB',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.aureliaReady === '1', { timeout: 10_000 });
  return { browser, context, page, problems };
}

/** Step the loaded app forward deterministically and wait for the paint. */
export async function advance(page, frames) {
  await page.evaluate((count) => globalThis.__aureliaStep(count), frames);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

/** One gesture, spoken as taps and drags in CSS pixels. */
export async function gesture(page, steps) {
  for (const step of steps) {
    if (step.type === 'drag') {
      await page.mouse.move(step.from.x, step.from.y);
      await page.mouse.down();
      for (const point of step.path ?? []) await page.mouse.move(point.x, point.y, { steps: step.substeps ?? 8 });
      await page.mouse.up();
    } else if (step.type === 'touch-drag') {
      // A real touch, so the browser reports pointerType 'touch' and the app
      // takes its Android code path.
      await page.evaluate(async ({ from, to, samples }) => {
        const canvas = document.querySelector('#field');
        const at = (point) => ({
          pointerId: 42,
          pointerType: 'touch',
          isPrimary: true,
          button: 0,
          clientX: point.x,
          clientY: point.y,
          bubbles: true,
          cancelable: true,
        });
        canvas.dispatchEvent(new PointerEvent('pointerdown', at(from)));
        for (let i = 1; i <= samples; i += 1) {
          const t = i / samples;
          canvas.dispatchEvent(
            new PointerEvent('pointermove', at({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })),
          );
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        canvas.dispatchEvent(new PointerEvent('pointerup', at(to)));
      }, { from: step.from, to: step.to, samples: step.samples ?? 10 });
    } else if (step.type === 'wait') {
      await advance(page, step.frames);
    }
  }
}
