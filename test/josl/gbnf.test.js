import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { toGbnf, tomlToGbnf, parseJosl, parseToml } from '@jarenjs/josl';
import { parseGbnf, toBnf, recognizes, generate } from './gbnf-engine.js';

const SUITE = fileURLToPath(new URL('../../benchmark/toml-test-suite/tests/', import.meta.url));
const FILELIST = join(SUITE, 'files-toml-1.0.0');
const available = existsSync(FILELIST);

function listTomlFiles(kind) {
  if (!available)
    return [];
  return readFileSync(FILELIST, 'utf8')
    .split('\n')
    .filter((f) => f.startsWith(`${kind}/`) && f.endsWith('.toml'))
    .sort();
}

function read(file) {
  const text = readFileSync(join(SUITE, file), 'utf8');
  // a BOM is an encoding artifact the parser strips before the grammar
  // starts, and is not something a constrained sampler should emit
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

const tomlBnf = toBnf(parseGbnf(tomlToGbnf()));
const joslBnf = toBnf(parseGbnf(toGbnf()));

// Rules a context-free grammar cannot enforce: everything that depends on
// what the document already said, plus value ranges inside a well-formed
// token. A generated sample rejected for one of these is the grammar
// behaving correctly, not a bug.
const SEMANTIC = /duplicate key|invalid date|invalid time|invalid date-time|already defined|conflicts with|cannot extend|exceeds|is not an array|cannot use static|cannot mix a root|invalid regexp/;

//#region shape

describe('josl: gbnf grammar is well formed', () => {
  it('parses as GBNF with root as the entry rule', () => {
    const rules = parseGbnf(tomlToGbnf());
    ok(rules.has('root'), 'no root rule');
    ok(rules.size > 40, `expected a full grammar, got ${rules.size} rules`);
  });
  it('defines every rule it references', () => {
    for (const grammar of [tomlToGbnf(), toGbnf()]) {
      const rules = parseGbnf(grammar);
      // toBnf throws on an unresolved reference
      toBnf(rules);
    }
  });
  it('leaves no rule unreachable from root', () => {
    for (const [label, grammar] of [['toml', tomlToGbnf()], ['josl', toGbnf()]]) {
      const bnf = toBnf(parseGbnf(grammar));
      const seen = new Set([bnf.names.get('root')]);
      const queue = [bnf.names.get('root')];
      while (queue.length !== 0) {
        for (const seq of bnf.alts[queue.pop()])
          for (const sym of seq)
            if (sym.rule !== undefined && !seen.has(sym.rule)) {
              seen.add(sym.rule);
              queue.push(sym.rule);
            }
      }
      const dead = [...bnf.names]
        .filter(([name, idx]) => !seen.has(idx) && !name.includes('~'))
        .map(([name]) => name);
      strictEqual(dead.length, 0, `${label}: unreachable rules ${dead.join(', ')}`);
    }
  });
  it('omits the JOSL-only forms in toml mode', () => {
    const toml = tomlToGbnf();
    for (const rule of ['null-lit', 'bigint', 'regexp'])
      ok(!toml.includes(`${rule} ::=`), `toml grammar still defines ${rule}`);
    ok(toGbnf().includes('null-lit ::='), 'josl grammar is missing null-lit');
  });
});

//#endregion

//#region the grammar accepts what the parser accepts

describe('josl: gbnf accepts the official valid corpus', () => {
  it('suite submodule is initialized', {
    skip: available
      ? false
      : "run 'git submodule update --init benchmark/toml-test-suite' to enable the grammar corpus check",
  }, () => ok(available));
  it('recognizes every valid TOML case in both modes', () => {
    const missed = [];
    for (const file of listTomlFiles('valid')) {
      const text = read(file);
      if (!recognizes(tomlBnf, text))
        missed.push(`toml: ${file}`);
      if (!recognizes(joslBnf, text))
        missed.push(`josl: ${file}`);
    }
    strictEqual(missed.length, 0, missed.slice(0, 10).join('\n'));
  });
});

describe('josl: gbnf covers the JOSL extensions', () => {
  for (const doc of ['n = null\n', 'b = 123n\n', 'h = 0xffn\n', 're = /a+[/x]/gi\n', '[[]]\nid = 1\n']) {
    it(`accepts ${JSON.stringify(doc)} in josl mode`, () => {
      ok(recognizes(joslBnf, doc));
      // and the parser agrees the text is a document
      parseJosl(doc);
    });
    it(`rejects ${JSON.stringify(doc)} in toml mode`, () => {
      ok(!recognizes(tomlBnf, doc));
    });
  }
});

describe('josl: gbnf rejects malformed text', () => {
  for (const doc of [
    'a = \n',
    'a = 01\n',
    'a = "unterminated\n',
    'a = [1, 2\n',
    'a = {b = 1\n',
    '[unclosed\n',
    'a = 1 oops\n',
    'a b = 1\n',
    'a = "\\q"\n',
    'a = "\\uD800"\n',
    'a = "\\U00110000"\n',
  ]) {
    it(`rejects ${JSON.stringify(doc)}`, () => {
      ok(!recognizes(tomlBnf, doc), 'grammar accepted malformed text');
    });
  }
  it('rejects most of the official invalid corpus outright', () => {
    const files = listTomlFiles('invalid');
    if (files.length === 0)
      return;
    let rejected = 0;
    for (const file of files)
      if (!recognizes(tomlBnf, read(file)))
        rejected++;
    // the rest fail on rules no context-free grammar can carry (duplicate
    // keys, table conflicts, out-of-range date parts); they are the
    // parser's job, and this pins the split so a regression shows up
    ok(rejected >= 395, `grammar only rejected ${rejected}/${files.length} invalid cases`);
  });
});

//#endregion

//#region everything the grammar generates, the parser accepts

// The safety direction for constrained sampling: a model steered by this
// grammar must never be able to produce text the parser then rejects.
// Derivations are seeded, so a failure names the seed that reproduces it.
describe('josl: gbnf generates only parseable text', () => {
  for (const [label, bnf, parse] of [['toml', tomlBnf, parseToml], ['josl', joslBnf, parseJosl]]) {
    it(`derives ${label} values the parser accepts`, () => {
      const failures = [];
      let generated = 0;
      for (let seed = 1; seed <= 1500; ++seed) {
        const text = generate(bnf, seed, 'val', 12);
        if (text.length === 0 || text.length > 400)
          continue;
        generated++;
        try {
          parse(`k = ${text}\n`);
        }
        catch (e) {
          if (!SEMANTIC.test(e.message))
            failures.push(`seed ${seed}: ${JSON.stringify(text).slice(0, 60)} -> ${e.message}`);
        }
      }
      ok(generated > 1000, `only ${generated} samples were generated`);
      strictEqual(failures.length, 0, failures.slice(0, 5).join('\n'));
    });
    it(`derives ${label} keys the parser accepts`, () => {
      const failures = [];
      for (let seed = 1; seed <= 400; ++seed) {
        const key = generate(bnf, seed, 'simple-key', 8);
        if (key.length === 0 || key.length > 200)
          continue;
        try {
          parse(`${key} = 1\n`);
        }
        catch (e) {
          if (!SEMANTIC.test(e.message))
            failures.push(`seed ${seed}: ${JSON.stringify(key).slice(0, 60)} -> ${e.message}`);
        }
      }
      strictEqual(failures.length, 0, failures.slice(0, 5).join('\n'));
    });
  }
});

//#endregion
