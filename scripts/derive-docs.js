#!/usr/bin/env node
//@ts-check
/**
 * Every derived span in every committed document, in one pass.
 *
 *   npm run docs:derive   # rewrite the documents from their sources
 *   npm run docs:check    # fail on drift, rewriting nothing
 *
 * The registries answer over different sources — committed benchmark
 * measurements and a bundle baseline, the pen documents themselves, and
 * the workspace manifests' `exports` — and stay separate for exactly
 * that reason.
 * The MARKER GRAMMAR is shared, which is what this file is: one
 * namespace, one bake per document, one report. Adding a registry here
 * is how a new kind of derived text arrives; adding a namespace is not.
 */

import process from 'node:process';
import './generate-adoption-census.js';
import { fileURLToPath } from 'node:url';

import { main } from './lib/derive.js';
import { measuredFigures } from './generate-benchmark-facts.js';
import { penTables } from './generate-pen-index.js';
import { exportInventory } from './generate-export-inventory.js';
import { penCoverage } from './generate-pen-census.js';
import { generateAuthoringProfiles } from './generate-authoring-profiles.js';
import { formsFacts } from './generate-forms-facts.js';
import { adoptionFacts } from './generate-adoption-facts.js';
import { formulaFacts } from './generate-formula-facts.js';
import { siteFacts } from './generate-site-facts.js';
import { durableFacts } from './generate-durable-facts.js';
import { providerFacts } from './generate-provider-facts.js';
import { lexicalFacts } from './generate-lexical-facts.js';
import { collectionFacts } from './generate-collection-facts.js';
import { relationalFacts } from './generate-relational-facts.js';
import { executionFacts } from './generate-execution-facts.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const profileDrift = generateAuthoringProfiles({ check: process.argv.includes('--check') });
if (profileDrift.length) {
  console.error('Authoring profile drift:', profileDrift.join(', '));
  process.exit(1);
}

process.exit(main({
  root: ROOT,
  registries: [measuredFigures, penTables, exportInventory, penCoverage, formsFacts, adoptionFacts, relationalFacts, collectionFacts, lexicalFacts, providerFacts, durableFacts, formulaFacts, siteFacts, executionFacts],
  argv: process.argv.slice(2),
}));
