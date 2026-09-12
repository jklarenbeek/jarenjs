//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkOutcome } from '@jarenjs/core/check';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileFsm, compileDag, compileStatechart, compileWorkflow } from '@jarenjs/flow';
import { normalizeModel, normalizeEntities } from '@jarenjs/db';
import { JarenValidator } from '@jarenjs/validate';
import { AUTHORING_PROFILES, generateAuthoringProfiles } from '../../scripts/generate-authoring-profiles.js';

const read = (pkg, name, suffix = '') => JSON.parse(readFileSync(new URL(`../../packages/${pkg}/schemas/jaren-${name}${suffix}.schema.json`, import.meta.url), 'utf8'));
const query = read('json', 'query');
const jslt = read('json', 'jslt');
const dag = read('flow', 'dag');
const corpus = {
  model: [{ $model: '0.1', collections: { notes: { schema: { type: 'object' }, key: '/id' } } }],
  query: [{$sum:'$.prices[*]'}, {$for:{r:'$.records[*]'},$return:'$r.id'}],
  jslt: [[{match:'$',body:{total:{$sum:'$.prices[*]'}}}]],
  app: [{state:{count:0},view:[{match:'$',body:{tag:'div',children:['hello']}}], actions:{inc:{state:{count:{$add:['$.count',1]}}}}}],
  fsm: [{initial:'idle',states:['idle','done'],transitions:[{from:'idle',to:'done',event:'GO'}]}],
  dag: [{$dag:'0.1',nodes:{input:{kind:'input'},output:{kind:'output'}},edges:[{from:'input',to:'output'}]}],
  statechart: [{$fsm:'0.2',initial:'idle',states:['idle',{id:'done',final:true}],transitions:[{from:'idle',to:'done',after:10}]}],
  workflow: [{$workflow:'0.2',revision:'1',initial:'done',states:{done:{final:true}}}],
};
const compilers = { model: (doc) => { normalizeModel(doc); normalizeEntities(doc); }, query: compileJsonQuery, jslt: compileJsltStylesheet, fsm: compileFsm, dag: compileDag,
  statechart: compileStatechart, workflow: compileWorkflow,
  app: (doc) => { compileJsltStylesheet(doc.view); Object.values(doc.actions ?? {}).forEach((action) => compileJsonQuery(action)); } };

describe('generated grammar profiles', () => {
  it('derives every profile without drift and detects source drift', () => {
    assert.deepEqual(generateAuthoringProfiles({ check: true }), []);
    const root = mkdtempSync(join(tmpdir(), 'jaren-profiles-'));
    try {
      for (const entry of AUTHORING_PROFILES) {
        const path = `packages/${entry.package}/schemas/jaren-${entry.grammar}.schema.json`;
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), JSON.stringify(read(entry.package, entry.grammar)));
      }
      mkdirSync(join(root, 'benchmark'));
      generateAuthoringProfiles({ root });
      const changed = read('json', 'query'); changed.title += ' changed';
      writeFileSync(join(root, 'packages/json/schemas/jaren-query.schema.json'), JSON.stringify(changed));
      assert.ok(generateAuthoringProfiles({ root, check: true }).includes('packages/json/schemas/jaren-query.authoring.schema.json'));
    }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const entry of AUTHORING_PROFILES) {
    it(entry.grammar + ' canonical corpus validates and compiles', () => {
      const schema = read(entry.package, entry.grammar);
      const validator = new JarenValidator({ skipErrors: false });
      for (const ref of [query, jslt, dag]) if (ref.$id !== schema.$id) validator.addSchema(ref);
      const check = validator.compile(schema);
      for (const doc of corpus[entry.grammar]) {
        assert.equal(checkOutcome(check(doc)).valid, true);
        assert.doesNotThrow(() => compilers[entry.grammar](doc));
      }
    });
  }
});
