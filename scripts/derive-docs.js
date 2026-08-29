#!/usr/bin/env node
//@ts-check
/**
 * Every derived span in every committed document, in one pass.
 *
 *   npm run docs:derive   # rewrite the documents from their sources
 *   npm run docs:check    # fail on drift, rewriting nothing
 *
 * The registries answer over different sources — committed benchmark
 * measurements and a bundle baseline on one side, the pen documents
 * themselves on the other — and stay separate for exactly that reason.
 * The MARKER GRAMMAR is shared, which is what this file is: one
 * namespace, one bake per document, one report. Adding a registry here
 * is how a new kind of derived text arrives; adding a namespace is not.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { main } from './lib/derive.js';
import { measuredFigures } from './generate-benchmark-facts.js';
import { penTables } from './generate-pen-index.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

process.exit(main({
  root: ROOT,
  registries: [measuredFigures, penTables],
  argv: process.argv.slice(2),
}));
