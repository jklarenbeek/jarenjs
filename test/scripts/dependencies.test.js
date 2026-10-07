//@ts-check
/**
 * @file The dependency gate's advisory half, decided over stubbed audits.
 *
 * An advisory is covered by its id, never by the name of the package it
 * sits on: a new advisory on a package the list already covers fails, a
 * recorded advisory reported on another package fails, one reported above
 * the severity it was reviewed at or at a label off npm's scale fails, a
 * flagged package the audit names no advisory for fails, and a recorded
 * advisory the audit no longer reports fails too, so the list cannot rot.
 * The CLI reads the audit from a file here, so none of this needs a
 * registry; an npm error report is an audit that did not run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditFindings, advisoryId, KNOWN_TOOLING_ADVISORIES } from '../../scripts/check-dependencies.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-dependencies.js', import.meta.url));

/** One advisory as `npm audit --json` lists it in a package's `via`. */
const advisory = (/** @type {string} */ id, /** @type {string} */ pkg, /** @type {string} */ severity) => ({
  source: 1, name: pkg, dependency: pkg, title: 'stub', url: `https://github.com/advisories/${id}`, severity, range: '*',
});

/** The vulnerability map the recorded list describes: each advisory on its own package, nothing else. */
function recordedAudit() {
  /** @type {Record<string, any>} */
  const vulnerabilities = {};
  for (const [id, { package: pkg, severity }] of Object.entries(KNOWN_TOOLING_ADVISORIES)) {
    vulnerabilities[pkg] ??= { name: pkg, severity, isDirect: false, via: [], effects: [], range: '*', nodes: [], fixAvailable: false };
    vulnerabilities[pkg].via.push(advisory(id, pkg, severity));
  }
  return vulnerabilities;
}

/** A vulnerability map in the order npm writes one: by package name. @param {Record<string, any>} vulnerabilities */
const sortedByName = (vulnerabilities) =>
  Object.fromEntries(Object.entries(vulnerabilities).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

describe('the advisory list is keyed by advisory id', () => {
  it('records each advisory once, with its package, a reviewed severity and a reason', () => {
    const ids = Object.keys(KNOWN_TOOLING_ADVISORIES);
    assert.ok(ids.length > 0);
    for (const [id, entry] of Object.entries(KNOWN_TOOLING_ADVISORIES)) {
      assert.match(id, /^GHSA(-[0-9a-z]{4}){3}$/, id);
      assert.ok(['info', 'low', 'moderate', 'high', 'critical'].includes(entry.severity), id);
      assert.ok(entry.package.length > 0 && entry.reason.length > 0, id);
    }
    assert.strictEqual(advisoryId(advisory('GHSA-aaaa-bbbb-cccc', 'x', 'low')), 'GHSA-aaaa-bbbb-cccc');
    assert.strictEqual(advisoryId({ source: 1234567 }), 'npm-1234567');
  });

  it('passes exactly the recorded advisories, and a package flagged only through one of them', () => {
    const vulnerabilities = { ...recordedAudit(), 'gh-pages': { name: 'gh-pages', severity: 'high', via: ['braces'] } };
    const findings = auditFindings(vulnerabilities);
    assert.deepStrictEqual(findings.failures, []);
    assert.strictEqual(findings.advisories, Object.keys(KNOWN_TOOLING_ADVISORIES).length);
    assert.strictEqual(findings.packages, Object.keys(vulnerabilities).length);
    assert.ok(findings.lines.some((line) => /GHSA-vfj7-8cjw-p6xm braces \(flags gh-pages\)/.test(line)), findings.lines.join('\n'));
  });

  it('fails a new advisory on a package the list already covers, whatever the package name', () => {
    const vulnerabilities = recordedAudit();
    vulnerabilities['brace-expansion'].via.push(advisory('GHSA-zzzz-zzzz-zzzz', 'brace-expansion', 'critical'));
    assert.deepStrictEqual(auditFindings(vulnerabilities).failures,
      ['new advisory not covered by the tooling list: GHSA-zzzz-zzzz-zzzz on brace-expansion (critical) — stub']);
    // a flagged package the audit names no advisory for is not covered by its name
    const named = auditFindings({ ...recordedAudit(), eslint: { severity: 'critical' } });
    assert.deepStrictEqual(named.failures,
      ['eslint is flagged (critical) through no advisory the audit names — refusing to treat it as covered']);
  });

  it('fails a recorded advisory reported above the severity it was reviewed at', () => {
    const vulnerabilities = recordedAudit();
    vulnerabilities.katex.via = [advisory('GHSA-238p-pmpm-9mq7', 'katex', 'critical')];
    assert.deepStrictEqual(auditFindings(vulnerabilities).failures,
      ['GHSA-238p-pmpm-9mq7 on katex is now critical, reviewed at low — review it again']);
  });

  it('fails a recorded advisory reported on a second package, wherever that package sorts', () => {
    // npm lists packages by name: lodash sorts before the recorded
    // lodash-es and lodash.template after it, and both must fail alike
    for (const carrier of ['lodash', 'lodash.template']) {
      const vulnerabilities = sortedByName({ ...recordedAudit(),
        [carrier]: { name: carrier, severity: 'high', via: [advisory('GHSA-r5fr-rjxr-66jc', carrier, 'high')] } });
      assert.deepStrictEqual(auditFindings(vulnerabilities).failures,
        [`GHSA-r5fr-rjxr-66jc is recorded on lodash-es but reported on ${['lodash-es', carrier].sort().join(', ')} — review it again`],
        carrier);
    }
    // an advisory that moved off its recorded package entirely fails the same way
    const moved = recordedAudit();
    moved['lodash-es'].via = moved['lodash-es'].via.filter((/** @type {any} */ via) => !via.url.endsWith('GHSA-r5fr-rjxr-66jc'));
    moved.lodash = { name: 'lodash', severity: 'high', via: [advisory('GHSA-r5fr-rjxr-66jc', 'lodash', 'high')] };
    assert.deepStrictEqual(auditFindings(sortedByName(moved)).failures,
      ['GHSA-r5fr-rjxr-66jc is recorded on lodash-es but reported on lodash — review it again']);
  });

  it('fails a recorded advisory reported at a severity npm does not use, beside a known one too', () => {
    for (const label of ['Critical', 'severe']) {
      const vulnerabilities = recordedAudit();
      vulnerabilities.katex.via = [advisory('GHSA-238p-pmpm-9mq7', 'katex', label)];
      assert.deepStrictEqual(auditFindings(vulnerabilities).failures,
        [`GHSA-238p-pmpm-9mq7 on katex is reported at an unknown severity '${label}' — review it again`], label);
    }
    const twice = recordedAudit();
    twice.katex.via = [advisory('GHSA-238p-pmpm-9mq7', 'katex', 'low'), advisory('GHSA-238p-pmpm-9mq7', 'katex', 'severe')];
    assert.deepStrictEqual(auditFindings(twice).failures,
      ['GHSA-238p-pmpm-9mq7 on katex is reported at an unknown severity \'severe\' — review it again']);
  });

  it('fails a recorded advisory the audit no longer reports, so the list cannot rot', () => {
    const vulnerabilities = recordedAudit();
    delete vulnerabilities.uuid;
    assert.deepStrictEqual(auditFindings(vulnerabilities).failures,
      ['recorded advisory GHSA-w5hq-g745-h8pq (uuid) is no longer reported — remove its entry']);
  });

  it('fails any advisory-flagged package that is a published one', () => {
    const vulnerabilities = { ...recordedAudit(), '@jarenjs/core': { severity: 'low', via: ['katex'] } };
    assert.deepStrictEqual(auditFindings(vulnerabilities, { published: new Set(['@jarenjs/core']) }).failures,
      ['advisory reaches a PUBLISHED package: @jarenjs/core']);
  });
});

describe('the CLI reads the audit it is handed', () => {
  /** Run the gate over one stubbed audit. @param {unknown} report */
  function gate(report) {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-audit-'));
    try {
      const file = join(dir, 'audit.json');
      writeFileSync(file, JSON.stringify(report));
      return spawnSync(process.execPath, [SCRIPT, '--audit', file], { encoding: 'utf8' });
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('passes the recorded advisories and fails a new one, by exit code', () => {
    const passed = gate({ vulnerabilities: recordedAudit() });
    assert.strictEqual(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /Dependency gate passed\./);
    const vulnerabilities = recordedAudit();
    vulnerabilities.eslint = { severity: 'critical', via: [advisory('GHSA-zzzz-zzzz-zzzz', 'eslint', 'critical')] };
    const failed = gate({ vulnerabilities });
    assert.strictEqual(failed.status, 1);
    assert.match(failed.stderr, /✗ new advisory not covered by the tooling list: GHSA-zzzz-zzzz-zzzz on eslint \(critical\)/);
  });

  it('reads an npm error report as an audit that did not run, and a clean audit as one that found nothing', () => {
    /** The lines the gate marks as failures. @param {{ stderr: string }} result */
    const failures = (result) => result.stderr.split('\n').filter((line) => line.startsWith('  ✗ '));
    // what npm prints when the advisory endpoint fails (exit 1, the report on stdout)
    const unreachable = gate({
      message: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
      method: 'POST', uri: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    });
    assert.strictEqual(unreachable.status, 1);
    assert.deepStrictEqual(failures(unreachable), ['  ✗ npm audit returned no vulnerability map: request to '
      + 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org']);
    // npm's general error shape
    const unlocked = gate({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.', detail: 'Try npm i --package-lock-only' } });
    assert.strictEqual(unlocked.status, 1);
    assert.deepStrictEqual(failures(unlocked), ['  ✗ npm audit returned no vulnerability map: This command requires an existing lockfile.']);
    // a clean audit carries an empty map, so every recorded advisory is stale
    const clean = gate({ vulnerabilities: {} });
    assert.strictEqual(clean.status, 1);
    assert.deepStrictEqual(failures(clean), Object.entries(KNOWN_TOOLING_ADVISORIES).map(([id, entry]) =>
      `  ✗ recorded advisory ${id} (${entry.package}) is no longer reported — remove its entry`));
  });

  it('runs when it is invoked through a symbolic link', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-audit-link-'));
    try {
      const link = join(dir, 'check-dependencies.js');
      try { symlinkSync(SCRIPT, link); }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') throw error;
        t.skip('this host does not let an unprivileged user create a symbolic link');
        return;
      }
      const file = join(dir, 'audit.json');
      const vulnerabilities = recordedAudit();
      vulnerabilities.eslint = { severity: 'critical', via: [advisory('GHSA-zzzz-zzzz-zzzz', 'eslint', 'critical')] };
      writeFileSync(file, JSON.stringify({ vulnerabilities }));
      const result = spawnSync(process.execPath, [link, '--audit', file], { encoding: 'utf8' });
      assert.strictEqual(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /✗ new advisory not covered by the tooling list: GHSA-zzzz-zzzz-zzzz on eslint \(critical\)/);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses --audit given twice instead of letting the later report decide', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-audit-twice-'));
    try {
      const failing = join(dir, 'failing.json');
      const passing = join(dir, 'passing.json');
      const vulnerabilities = recordedAudit();
      vulnerabilities.eslint = { severity: 'critical', via: [advisory('GHSA-zzzz-zzzz-zzzz', 'eslint', 'critical')] };
      writeFileSync(failing, JSON.stringify({ vulnerabilities }));
      writeFileSync(passing, JSON.stringify({ vulnerabilities: recordedAudit() }));
      // in either order: a passing report must not outvote a failing one
      for (const [first, second] of [[failing, passing], [passing, failing]]) {
        const result = spawnSync(process.execPath, [SCRIPT, '--audit', first, '--audit', second], { encoding: 'utf8' });
        assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /--audit given twice — use --skip-audit or --audit <file>/);
        assert.strictEqual(result.stdout, '', 'a check ran over one of the two reports');
      }
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an argument it does not know, an --audit without a file, and --skip-audit beside --audit', () => {
    for (const args of [['--audits'], ['--audit'], ['--skip-audit', '--audit', 'audit.json'],
      ['--audit', 'audit.json', '--skip-audit'], ['--audit', '--skip-audit']]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
      assert.strictEqual(result.status, 2, args.join(' '));
      assert.match(result.stderr, /--skip-audit or --audit <file>/);
      assert.strictEqual(result.stdout, '', `${args.join(' ')} ran a check`);
    }
  });
});
