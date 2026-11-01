/**
 * Browser driver: engine selection, launch, and one place where "the browser
 * could not run" becomes a loud failure.
 *
 * Playwright is not vendored here. It is resolved from PLAYWRIGHT_ENTRY, an
 * absolute path provided by the Nix shell, because ESM does not consult
 * NODE_PATH. Its absence is an error rather than a skip: a suite that reports
 * success after painting zero pages is worse than one that errors.
 *
 * Why Chromium is not the default, even though it is the engine most users have:
 * Chromium's headless shell dies in this environment before it paints, because
 * its sandbox helper needs syscalls the surrounding sandbox denies (SIGTRAP at
 * sandbox_host_linux.cc:41, and crashpad `setsockopt: Operation not permitted`).
 * Firefox does not need them, so it is the default. `--engine chromium` and
 * `--engine webkit` remain available and fail clearly if the browser cannot
 * start, rather than silently falling back and pretending to have tested
 * something else.
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_ENV = ['PLAYWRIGHT_ENTRY', 'PLAYWRIGHT_BROWSERS_PATH'];
export const DEFAULT_ENGINE = 'firefox';

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
  const playwright = module.default && module.chromium === undefined ? module.default : module;
  return {
    playwright,
    chromium: playwright.chromium,
    firefox: playwright.firefox,
    webkit: playwright.webkit,
  };
}

/** Viewports under test: desktop, portrait phone, landscape phone. */
export const SCENES = [
  { name: 'desktop', width: 1280, height: 800, device: false, orientation: 'landscape' },
  { name: 'phone-portrait', width: 390, height: 844, device: true, orientation: 'portrait' },
  { name: 'phone-landscape', width: 844, height: 390, device: true, orientation: 'landscape' },
];

/**
 * Whether a page can synthesise a touch through Playwright's own input pipeline.
 * Firefox's tap/touchscreen is unimplemented upstream, so on Firefox touches are
 * dispatched as pointer events instead - see `gesture` below.
 */
async function supportsNativeTouch(page) {
  try {
    await page.touchscreen.tap(1, 1);
    return true;
  } catch {
    return false;
  }
}

export async function openScene(engines, engineName, scene, url) {
  const engine = engines[engineName];
  if (!engine) throw new Error(`this Playwright build does not expose "${engineName}"`);
  const browser = await engine.launch({
    // Chromium's own sandbox needs user-namespace syscalls that the environments
    // these checks run in may not grant; the page is local, so this flag is about
    // the harness rather than the app.
    args: engineName === 'chromium'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
      : [],
  });
  const context = await browser.newContext({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: scene.device ? 2 : 1,
    isMobile: scene.device,
    hasTouch: true,
    reducedMotion: 'reduce',
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
  await page.waitForFunction(() => document.documentElement.dataset.aureliaReady === '1', { timeout: 20_000 });
  const nativeTouch = scene.device ? await supportsNativeTouch(page) : false;
  return { browser, context, page, problems, nativeTouch };
}

/** Step the loaded app forward deterministically and wait for the paint. */
/** Lift a finger left down by a `hold: true` step. Safe to call when none is. */
export async function releaseHeld(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('#field');
    if (!canvas.__heldPointer) return;
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...canvas.__heldPointer, buttons: 0 }));
    delete canvas.__heldPointer;
  });
}

export async function advance(page, frames) {
  await page.evaluate((count) => globalThis.__aureliaStep(count), frames);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

/**
 * Perform one gesture.
 *
 * A drag is delivered as a real `PointerEvent` sequence with pointerType 'touch'
 * on the canvas, in both engines, rather than through Playwright's mouse. Two
 * reasons: the app is touched on Android and moused on a desktop, and the same
 * scripted gesture must exercise the same code path in both - and on Firefox the
 * touchscreen API is not implemented at all, so a test that relied on it would
 * silently test nothing.
 */
export async function gesture(page, steps) {
  for (const step of steps) {
    if (step.type === 'wait') {
      await advance(page, step.frames);
    } else if (step.type === 'touch-drag') {
      await page.evaluate(
        async ({ from, to, samples, holdFrames, hold }) => {
          const canvas = document.querySelector('#field');
          const init = (point) => ({
            pointerId: 42,
            pointerType: 'touch',
            isPrimary: true,
            button: 0,
            buttons: 1,
            clientX: point.x,
            clientY: point.y,
            bubbles: true,
            cancelable: true,
          });
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          canvas.dispatchEvent(new PointerEvent('pointerdown', init(from)));
          for (let i = 1; i <= samples; i += 1) {
            const t = i / samples;
            canvas.dispatchEvent(
              new PointerEvent('pointermove', {
                ...init({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }),
              }),
            );
            await frame();
          }
          for (let i = 0; i < (holdFrames ?? 0); i += 1) await frame();
          // `hold` leaves the finger down: the app keeps the gesture live, so a
          // scene can be photographed mid-action. The harness releases it with
          // `releaseHeld` before the next one starts.
          if (hold) {
            canvas.__heldPointer = init(to);
            return;
          }
          canvas.dispatchEvent(
            new PointerEvent('pointerup', {
              ...init(to),
              buttons: 0,
            }),
          );
        },
        {
          from: step.from,
          to: step.to,
          samples: step.samples ?? 10,
          holdFrames: step.holdFrames ?? 0,
          hold: step.hold === true,
        },
      );
    } else {
      throw new Error(`unknown gesture type: ${step.type}`);
    }
  }
}
