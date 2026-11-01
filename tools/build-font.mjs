#!/usr/bin/env node
/**
 * Produce the fonts embedded in the artifact.
 *
 * The page used to ask for `ui-sans-serif, system-ui, ...`, which means the
 * browser picks a font the project does not own. That is fine for a person and
 * fatal for a screenshot test: CI's Firefox resolved the stack to different
 * faces than the dev shell, glyph advances drifted, every line of text fell out
 * of alignment, and all 18 goldens failed at 0.6-4.5% while looking identical
 * to the eye.
 *
 * So the artifact ships its own faces and asks for them by one family name.
 * Nothing on the host is consulted, so the same bytes render the same pixels
 * everywhere, which is also what the offline single-file promise needs: a font
 * fetched from the system is still an external dependency.
 *
 * DejaVu Sans is what the project already resolved to locally, so this changes
 * rendering nowhere for the committed baselines. Two faces are embedded:
 * Regular and Bold. The sheet asks for weights 550-700, and shipping only the
 * Regular face would make the browser synthesise its own fake bold, whose
 * stem weight varies by engine and would drift across machines all over again.
 *
 * The subset stays small on purpose. The page draws a few hundred characters;
 * the 489 KiB original is mostly glyphs Aurelia will never show.
 *
 * Subsetting and compression are two steps with two tools: `pyftsubset` selects
 * the glyphs and writes TTF, then `woff2_compress` encodes WOFF2. Going straight
 * to `--flavor=woff2` would be one less step, but fonttools only gains WOFF2
 * output when it can import a Brotli Python extension built for the *same*
 * interpreter, and in nixpkgs the fonttools CLI runs on a python whose brotli is
 * built for a different one. Depending on that pairing puts a version-matching
 * problem in the middle of a build that does not need one.
 *
 * Run ./tools/with-fonttools.sh, which provides pyftsubset and woff2_compress
 * from the pinned nixpkgs. The output is committed, so building and viewing the
 * artifact needs no network and no font tooling.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build');

/**
 * The characters that must have a glyph.
 *
 * Latin-1 covers the letters, digits and punctuation, plus the typographic
 * dashes and quotes the copy uses. The range is deliberately generous: a few
 * unused glyphs cost a little file size, while a missing glyph silently changes
 * a line's width, which is the exact failure this file exists to prevent.
 */
const COVERAGE = [
  ...Array.from({ length: 0x00ff - 0x0020 + 1 }, (_, i) => String.fromCharCode(0x0020 + i)),
  '\u2013', // en dash
  '\u2014', // em dash
  '\u2018\u2019\u201c\u201d', // curly quotes
  '\u2022', // bullet
  '\u2026', // ellipsis
];

/** Names the two faces so the CSS can alias them onto one family. */
const FACES = [
  { name: 'AureliaSans', weight: 400, source: 'DejaVuSans.ttf' },
  { name: 'AureliaSansBold', weight: 700, source: 'DejaVuSans-Bold.ttf' },
];

function subset(ttf, outTtf) {
  const unicodes = [...new Set(COVERAGE)].map((c) => c.codePointAt(0).toString(16)).join(',');
  execFileSync('pyftsubset', [
    ttf,
    `--output-file=${outTtf}`,
    `--unicodes=${unicodes}`,
    // No OpenType shaping features: the text is plain Latin, and variants such
    // as ligatures would make glyph choice depend on which features the
    // browser's engine enables by default.
    '--layout-features=',
    '--no-hinting',
    '--desubroutinize',
    '--name-IDs=',
    '--recalc-bounds',
  ], { stdio: 'inherit' });
}

/** `woff2_compress` writes sibling.woff2 next to its input, so the caller knows where. */
function toWoff2(ttf) {
  execFileSync('woff2_compress', [ttf], { stdio: 'inherit' });
  return ttf.replace(/\.ttf$/, '.woff2');
}

const fontDir = process.argv[2];
if (!fontDir) {
  console.error('usage: build-font.mjs <directory-containing-DejaVuSans.ttf>');
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
const lines = [];
for (const face of FACES) {
  const subsetTtf = join(OUT_DIR, `${face.name}.ttf`);
  subset(join(fontDir, face.source), subsetTtf);
  const woff2 = toWoff2(subsetTtf);
  const bytes = readFileSync(woff2);
  writeFileSync(`${woff2}.base64`, bytes.toString('base64'));
  lines.push(`${face.name} wght ${face.weight}: ${(bytes.length / 1024).toFixed(1)} KiB`);
}
process.stdout.write(`embedded fonts written to ${OUT_DIR}\n${lines.join('\n')}\n`);
