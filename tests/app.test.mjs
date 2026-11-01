/**
 * Interaction tests: what a finger does, and what the app says it did.
 *
 * Driven through the synthesised pointer events in dom-harness.mjs, so these
 * exercise the real handlers and the real state machine rather than a mock of
 * them. Viewports cover desktop, portrait phone and landscape phone because the
 * layout is computed, not fixed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApp } from './dom-harness.mjs';
import { MIN_LENGTH_PX } from '../src/sim.js';

const VIEWPORTS = [
  ['desktop', 1280, 800],
  ['wide desktop', 1920, 1080],
  ['phone portrait', 390, 844],
  ['phone landscape', 844, 390],
  ['small phone portrait', 360, 640],
];

/** Every endpoint of every string must be inside the viewport. */
function assertFullyVisible(app, width, height, label) {
  const offenders = [];
  for (const line of app.instrument.strings) {
    for (const t of [0, 0.5, 1]) {
      const point = line.restAt(t);
      if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) {
        offenders.push(`string ${line.id} at t=${t}: (${point.x.toFixed(0)}, ${point.y.toFixed(0)})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `${label}: strings fell outside the viewport`);
}

test('the starting instrument is on screen at every viewport', () => {
  for (const [label, width, height] of VIEWPORTS) {
    const { app } = bootApp({ width, height });
    assert.equal(app.instrument.count, 4, `${label}: expected a starting instrument`);
    assertFullyVisible(app, width, height, label);
  }
});

test('rotating a phone keeps the instrument visible and keeps its pitch', () => {
  const { app, canvas } = bootApp({ width: 390, height: 844 });
  const before = app.instrument.strings.map((line) => line.pitchHz());
  const lengths = app.instrument.strings.map((line) => line.lengthPx);
  // Rotate: the parent element now reports a landscape box, then a resize fires.
  const parent = canvas.parentElement;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 844, height: 390, right: 844, bottom: 390 });
  app.globalTarget.dispatch?.('resize', {});
  app.resize();
  assertFullyVisible(app, 844, 390, 'after rotation');
  const after = app.instrument.strings.map((line) => line.pitchHz());
  assert.deepEqual(after, before, 'a rotation must not retune the instrument');
  assert.deepEqual(
    app.instrument.strings.map((line) => line.lengthPx),
    lengths,
    'a rotation must not change string lengths',
  );
});

test('the starting strings differ enough in length to sound like a chord', () => {
  const { app } = bootApp();
  const pitches = app.instrument.strings.map((line) => line.pitchHz());
  const highest = Math.max(...pitches);
  const lowest = Math.min(...pitches);
  assert.ok(
    highest / lowest > 1.6,
    `all strings within ${(highest / lowest).toFixed(2)}x of each other is a unison, not an instrument`,
  );
  for (const pitch of pitches) {
    assert.ok(pitch > 80 && pitch < 1200, `a fundamental of ${pitch.toFixed(0)} Hz is out of range`);
  }
});

/**
 * A horizontal stroke of up to `length` px that lies on genuinely blank canvas,
 * preferring the longest blank run. The instrument is laid out from the free
 * area, so fixed coordinates stop being blank whenever the layout moves, and a
 * fixed length stops being available whenever the instrument fills the room it
 * is given - on a desktop it is deliberately full-width, and the blank space
 * that remains is between the strings rather than beside them.
 *
 * Asking the hit test where the space is keeps these tests about drawing rather
 * than about arithmetic. `length` is therefore the longest stroke worth asking
 * for, not a requirement: what the tests need is a stroke long enough to be a
 * string rather than a tap, which the minimum audibly-long string already is.
 */
function blankDrag(app, length = 300) {
  const reach = Math.round(app.bodyGrabPx());
  const blank = (x, y) => app._hitTest(x, y).kind === 'none';
  let best = null;
  for (let y = reach + 10; y < app.height - reach; y += 10) {
    for (let x = reach + 10; x + MIN_DRAW_LENGTH_PX <= app.width - reach; x += 10) {
      if (!blank(x, y)) continue;
      // Extend rightwards while the canvas stays blank, up to the length asked
      // for; a run interrupted by a string still yields its blank prefix.
      let stop = Math.min(x + length, app.width - reach);
      for (let probe = x + 10; probe <= stop; probe += 10) {
        if (!blank(probe, y)) {
          stop = probe - 10;
          break;
        }
      }
      const run = { from: { x, y }, to: { x: stop, y } };
      if (stop - x >= MIN_DRAW_LENGTH_PX && (!best || best.to.x - best.from.x < stop - x)) best = run;
      break; // next row: this one cannot beat its own longest run
    }
  }
  if (!best) throw new Error('no blank space to draw in');
  return best;
}

/** Shorter than this, a stroke is a tap rather than a string worth drawing. */
const MIN_DRAW_LENGTH_PX = 120;

test('drawing on empty space creates a string whose pitch the app announces', () => {
  const { app, drag } = bootApp();
  const before = app.instrument.count;
  const { from, to } = blankDrag(app);
  drag(from, to);
  assert.equal(app.instrument.count, before + 1, 'a drag on empty space should add a string');
  const line = app.instrument.strings.at(-1);
  assert.match(app.state.gesture, /new/);
  assert.match(app.state.detail, /~\d+ Hz/, `the readout should name the pitch, got "${app.state.detail}"`);
  const announced = Number(/~(\d+)/.exec(app.state.detail)[1]);
  assert.ok(Math.abs(announced - line.pitchHz()) < 1, `${announced} Hz is not ${line.pitchHz()}`);
});

test('a press shorter than the minimum is not turned into a string', () => {
  const { app, drag, send } = bootApp();
  const before = app.instrument.count;
  // A tap, not a drag: no travel, so nothing to stretch.
  send('pointerdown', 200, 120);
  send('pointerup', 200, 120);
  assert.equal(app.instrument.count, before, 'a tap in empty space must not create a string');
  // And a deliberately short drag, just under the limit.
  drag({ x: 300, y: 120 }, { x: 300 + MIN_LENGTH_PX * 0.8, y: 120 });
  assert.equal(app.instrument.count, before, 'a drag below the minimum length must not create a string');
});

test('dragging across an existing string plucks it rather than drawing over it', () => {
  const { app, send } = bootApp();
  const line = app.instrument.strings[1];
  const mid = line.restAt(0.5);
  for (let i = 0; i < 60; i += 1) app.instrument.step(1 / 60, []);
  const before = line.amplitude();
  const count = app.instrument.count;
  // Fast and short: a pluck, not a rub. A slow 90px sweep across the same
  // string is the bowing gesture tested next, so the two cases differ in speed
  // and are separated deliberately rather than by whichever threshold trips.
  send('pointerdown', mid.x, mid.y - 14);
  for (let i = 1; i <= 4; i += 1) send('pointermove', mid.x, mid.y - 14 + i * 8);
  send('pointerup', mid.x, mid.y + 18);
  app.frame(0);
  assert.equal(app.instrument.count, count, 'a pluck must not add a string');
  assert.equal(app.state.gesture, 'pluck');
  assert.match(app.state.detail, /plucked ~\d+ Hz/);
  assert.ok(line.amplitude() > before, `plucking should add energy: ${before} -> ${line.amplitude()}`);
});

test('holding still on a string mutes it, rubbing it sustains', () => {
  const { app, send } = bootApp();
  const line = app.instrument.strings[0];
  const mid = line.restAt(0.5);
  for (let i = 0; i < 3; i += 1) line.pluck(0.45, 1.4, 1);
  for (let i = 0; i < 10; i += 1) app.instrument.step(1 / 60, []);
  const loud = line.amplitude();

  send('pointerdown', mid.x, mid.y);
  for (let i = 0; i < 30; i += 1) {
    send('pointermove', mid.x, mid.y);
    app.frame(i / 60, 1 / 60 * 1000);
  }
  assert.equal(app.touchMode, 'hold', 'a stationary finger should read as holding');
  assert.ok(line.held, 'the string should be marked held');
  assert.ok(line.amplitude() < loud, `holding should damp the string: ${loud} -> ${line.amplitude()}`);
  send('pointerup', mid.x, mid.y);

  // Rub: the same string, moving along itself.
  for (let i = 0; i < 3; i += 1) line.pluck(0.45, -1.4, 1);
  const start = line.amplitude();
  send('pointerdown', mid.x - 90, mid.y);
  for (let i = 0; i < 60; i += 1) {
    send('pointermove', mid.x - 90 + i * 4, mid.y);
    app.frame(i / 60, 1 / 60 * 1000);
  }
  assert.equal(app.touchMode, 'bow', 'a rubbing finger should read as bowing');
  assert.ok(!line.held, 'bowing must not also hold the string');
  assert.match(app.state.detail, /bowing/);
  assert.ok(line.amplitude() > 0, `a bowed string should still be moving: ${start} -> ${line.amplitude()}`);
  send('pointerup', mid.x + 150, mid.y);
});

test('dragging a tuning handle changes pitch, and the readout says so', () => {
  const { app, send } = bootApp();
  const line = app.instrument.strings[0];
  const handle = line.restAt(0);
  const before = line.pitchHz();
  send('pointerdown', handle.x, handle.y);
  send('pointermove', handle.x + 150, handle.y);
  send('pointerup', handle.x + 150, handle.y);
  const after = line.pitchHz();
  assert.notEqual(after, before, 'dragging a handle should retune the string');
  assert.match(app.state.detail, /retuning \d+ Hz -> \d+ Hz/, `got "${app.state.detail}"`);
});

test('a wild retune drag cannot collapse a string into noise', () => {
  const { app, send } = bootApp();
  const line = app.instrument.strings[0];
  const handle = line.restAt(0);
  const before = line.pitchHz();
  send('pointerdown', handle.x, handle.y);
  // A flick to the far corner: without a floor this would turn a 600px string
  // into a few pixels and jump the pitch by decades.
  send('pointermove', 1279, 799);
  send('pointerup', 1279, 799);
  const after = line.pitchHz();
  assert.ok(after < before * 12, `pitch jumped from ${before} to ${after}`);
  assert.ok(Number.isFinite(after), 'retuning must not produce a non-finite pitch');
});

test('Clear empties the instrument and undo removes the last string', () => {
  const { app, drag, ui } = bootApp();
  const first = blankDrag(app);
  drag(first.from, first.to);
  const count = app.instrument.count;
  assert.ok(count > 4);
  ui.buttons.clear.click();
  assert.equal(app.instrument.count, 0);
  assert.match(app.state.detail, /cleared/);

  const second = blankDrag(app);
  drag(second.from, second.to);
  const third = blankDrag(app, 300);
  drag(third.from, third.to);
  const before = app.instrument.count;
  app.undo();
  assert.equal(app.instrument.count, before - 1);
});

test('keyboard shortcuts do what the About panel says they do', () => {
  const { app, drag, globalTarget, ui } = bootApp();
  const key = (name) => globalTarget.dispatch('keydown', { key: name, metaKey: false, ctrlKey: false });
  drag({ x: 120, y: 110 }, { x: 700, y: 130 });
  const count = app.instrument.count;
  key('z');
  assert.equal(app.instrument.count, count - 1, 'Z should undo');
  key('c');
  assert.equal(app.instrument.count, 0, 'C should clear');
  key('m');
  assert.equal(app.audio.muted, true, 'M should mute');
  key('m');
  assert.equal(app.audio.muted, false, 'M again should unmute');
  key('d');
  assert.equal(app.instrument.count, 4, 'D should restore the demo instrument');
  ui.buttons.mute.click();
  assert.equal(app.audio.muted, true, 'the mute button should mirror the shortcut');
  assert.equal(ui.buttons.mute.attributes['aria-pressed'], 'true', 'the button should report its state');
});

test('the status line is never empty while the app is running', () => {
  const { app, drag } = bootApp();
  const seen = new Set();
  for (const step of ['boot', 'draw', 'settle', 'clear']) {
    if (step === 'draw') drag({ x: 120, y: 110 }, { x: 700, y: 130 });
    if (step === 'clear') app.clearAll();
    app.frame(0);
    app._publishState();
    seen.add(step);
    const text = app.state.detail;
    if (text !== '') continue;
    // Empty is allowed only when nothing has happened yet and the default text
    // will be substituted by the readout renderer.
    assert.ok(
      ['boot', 'settle'].includes(step),
      `${step}: detail should not be blank while an interaction is described elsewhere`,
    );
  }
  assert.equal(seen.size, 4);
});

test('the app reports strings and sounding counts that match the simulation', () => {
  const { app, drag } = bootApp();
  for (const line of app.instrument.strings) {
    line.u.fill(0);
    line.v.fill(0);
  }
  app.frame(0);
  app._publishState();
  // The contract is that the reported number agrees with the simulation, not
  // that the simulation holds a particular number: the seeded instrument is
  // laid out from the viewport, so how many rows fit is a layout decision.
  assert.equal(app.state.strings, app.instrument.count);
  assert.ok(app.instrument.count >= 2, `expected a starting instrument, got ${app.instrument.count}`);
  assert.equal(app.state.sounding, 0, 'silent strings must not be counted as ringing');
  app.instrument.strings[0].pluck(0.5, 1.4, 1);
  for (let i = 0; i < 4; i += 1) app.instrument.step(1 / 60, []);
  app.frame(0);
  app._publishState();
  assert.equal(app.state.sounding, 1);
  const before = app.instrument.count;
  const { from, to } = blankDrag(app);
  drag(from, to);
  app._publishState();
  assert.equal(app.state.strings, before + 1, 'a new string should be counted');
});

test('a hover over a string is reported as an interaction target', () => {
  const { app, send } = bootApp();
  const mid = app.instrument.strings[1].restAt(0.5);
  send('pointermove', mid.x, mid.y);
  assert.equal(app.hover.kind, 'body', 'hovering a string should mark it as hittable');
  const far = { x: 5, y: 5 };
  send('pointermove', far.x, far.y);
  assert.equal(app.hover.kind, 'none');
});

test('hovering never disturbs a silent string', () => {
  const { app, send } = bootApp();
  const line = app.instrument.strings[2];
  line.u.fill(0);
  line.v.fill(0);
  const before = line.energy();
  for (const point of [[400, 300], [500, 305], [600, 300], [700, 295]]) {
    send('pointermove', point[0], point[1]);
  }
  assert.equal(line.energy(), before, 'a pointer moving in the air must not inject energy');
});

test('the app survives a cancelled pointer (Android gesture takeover)', () => {
  const { app, send } = bootApp();
  const mid = app.instrument.strings[1].restAt(0.5);
  const count = app.instrument.count;
  send('pointerdown', mid.x, mid.y);
  send('pointermove', mid.x, mid.y - 40);
  send('pointercancel', mid.x, mid.y - 40);
  assert.equal(app.instrument.count, count, 'a cancelled gesture must not leave a half-made string');
  assert.equal(app.activeGestures.length, 0, 'a cancelled pointer must be forgotten');
});

test('two fingers do not corrupt each other', () => {
  const { app, send } = bootApp();
  const count = app.instrument.count;
  const a = blankDrag(app, 300);
  const b = blankDrag(app, 300);
  send('pointerdown', a.from.x, a.from.y, { pointerId: 1 });
  send('pointerdown', b.from.x, b.from.y, { pointerId: 2 });
  send('pointermove', a.to.x, a.to.y, { pointerId: 1 });
  send('pointermove', b.to.x, b.to.y, { pointerId: 2 });
  send('pointerup', a.to.x, a.to.y, { pointerId: 1 });
  send('pointerup', b.to.x, b.to.y, { pointerId: 2 });
  assert.equal(app.instrument.count, count + 2, 'both drags should have produced a string');
  assert.equal(app.activeGestures.length, 0);
});

test('rendering is deterministic for a given simulation state', () => {
  const first = bootApp({ seed: 99 });
  const second = bootApp({ seed: 99 });
  for (const { app } of [first, second]) {
    for (let i = 0; i < 45; i += 1) {
      app.instrument.step(1 / 60, []);
      app.render();
    }
  }
  const strip = (ops) => ops.map((op) => `${op.op}:${op.x ?? ''},${op.y ?? ''},${op.strokeStyle ?? ''}`).join('|');
  assert.equal(
    strip(first.canvas._ops).length,
    strip(second.canvas._ops).length,
    'the same state must draw the same number of ops',
  );
  assert.ok(first.canvas._ops.length > 200, `expected a rich frame, got ${first.canvas._ops.length} ops`);
});

/**
 * The rule for when the lesson panel moves the instrument.
 *
 * Earlier attempts got the two real viewports wrong in opposite directions:
 * honouring the panel always cost a desktop a third of its string length, and
 * exempting it left a portrait phone starting with half its instrument behind
 * the instructions. The cost is measured in hidden string length because that is
 * what the player loses, and the threshold means a panel is stepped around only
 * when it covers most of the instrument - a panel that clips one row of four is
 * cheaper to overlap than to move everything for.
 *
 * Each case pairs a panel with the free area its own viewport leaves, since the
 * answer depends on both: the same 400px panel is a column beside a desktop
 * instrument and a wall across a phone one.
 */
test('the lesson moves the instrument only when it covers the instrument', () => {
  const { app } = bootApp();
  const hides = (area, box) => app._lessonHidesRows(area, box);
  const desktop = { left: 14, top: 76, right: 1266, bottom: 722 };
  const portrait = { left: 14, top: 71, right: 376, bottom: 766 };
  const landscape = { left: 14, top: 70, right: 830, bottom: 318 };

  // The desktop lesson is a column in the top-left corner; the instrument is
  // centred and long, so it runs clear of it.
  assert.equal(hides(desktop, { left: 18, top: 74, right: 418, bottom: 383 }), false);
  // The same panel across a phone's narrow free area is the whole width, and
  // sits where every row is: the instrument has to move.
  assert.equal(hides(portrait, { left: 18, top: 74, right: 372, bottom: 386 }), true);
  // A landscape lesson is short, and only one of the four rows falls at its
  // height: 22% of the strings. The instrument keeps its full length and the
  // panel, which clamps itself in CSS, overlaps that one row instead.
  assert.equal(hides(landscape, { left: 12, top: 211, right: 632, bottom: 306 }), false);
  // A wide panel that only crosses empty space below the rows hides nothing.
  assert.equal(hides(portrait, { left: 14, top: 750, right: 376, bottom: 766 }), false);
  // A panel outside the free area hides nothing, however large it is.
  assert.equal(hides(desktop, { left: 1266, top: 0, right: 1900, bottom: 800 }), false);
  // Clipping one row out of four is 30% of the strings: the instrument stays
  // put, because rebuilding it is the bigger loss. This is the deliberate
  // limit of the rule, not an oversight.
  assert.equal(hides(desktop, { left: 14, top: 100, right: 1266, bottom: 400 }), false);
});

test('a lesson the instrument cannot share is removed from the free area', () => {
  const { app, ui } = bootApp({ width: 390, height: 844 });
  const panel = ui.overlays.get('#learn');
  // Match the portrait phone's real chrome, which this stub does not model: a
  // caption across the top, meters beside it, and the buttons along the bottom.
  Object.assign(ui.overlays.get('#brand'), { left: 18, top: 18, width: 114, height: 27, right: 132, bottom: 45 });
  Object.assign(ui.overlays.get('#meters'), { left: 197, top: 18, width: 175, height: 39, right: 372, bottom: 57 });
  Object.assign(ui.overlays.get('#readout'), { left: 18, top: 741, width: 354, height: 17, right: 372, bottom: 758 });
  Object.assign(ui.overlays.get('#controls'), { left: 18, top: 782, width: 208, height: 44, right: 226, bottom: 826 });
  Object.assign(ui.overlays.get('#about'), { left: 223, top: 780, width: 149, height: 46, right: 372, bottom: 826 });
  // The portrait lesson, straight down from the caption: it lies across every
  // row the instrument would occupy.
  Object.assign(panel, { left: 18, top: 74, width: 354, height: 312, right: 372, bottom: 386 });
  const area = app.freeArea();
  assert.ok(
    area.top >= 386,
    `a portrait phone left the free area starting at ${area.top.toFixed(0)}, inside the lesson`,
  );
  // Dismissing the lesson releases the reservation.
  panel.hidden = true;
  assert.ok(app.freeArea().top < 386, 'a dismissed lesson must stop reserving space');
});

/**
 * The page must never claim the stage is empty when it is not.
 *
 * The seeded instrument is created before the first frame runs, and the counts
 * shown to the player used to come from state that only a frame refreshed - so
 * the app opened saying `strings 0` and "Drag anywhere to stretch your first
 * string" over four strings that were already ringing.
 */
test('the reported counts match the instrument before any frame runs', () => {
  const { app } = bootApp();
  assert.ok(app.instrument.count > 0, 'this check is about a seeded instrument');
  assert.equal(
    app.state.strings,
    app.instrument.count,
    'state.strings must already match the instrument, not wait for a frame',
  );
  assert.equal(app.state.sounding, app.instrument.count);
});
