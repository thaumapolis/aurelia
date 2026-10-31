#!/usr/bin/env node
/**
 * Write index.html from src/. Thin wrapper around tools/build-lib.mjs so the
 * same build can be run in-process by the tests, which cannot spawn a child
 * process in a sandbox that forbids it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArtifact } from './build-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'index.html');

const page = buildArtifact(ROOT);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page);
process.stdout.write(`built ${OUT} (${(Buffer.byteLength(page) / 1024).toFixed(1)} KiB)\n`);
