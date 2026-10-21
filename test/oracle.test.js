import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Oracle } from '../src/oracle.js';
import { confidenceBadge } from '../src/artifacts.js';
import { tempDir, write } from './helpers.js';
import { join } from 'node:path';

const FAIL_IF = `const fs = require('node:fs');
const data = fs.readFileSync(process.argv[2], 'utf8');
if (data.includes('BUGMARK')) {
  throw new TypeError('ORACLE_MARK exploded');
}
`;

function oracleFor(scratch, scriptText, inputText) {
  const script = write(scratch.dir, 'repro.js', scriptText);
  return new Oracle({ repro: script, inputText, inputName: 'input.json' });
}

test('calibrate 10/10 -> deterministic; probeCandidate caches and can go fresh', async () => {
  const scratch = tempDir('minrepro-or-');
  try {
    const oracle = oracleFor(scratch, FAIL_IF, 'payload has BUGMARK here');
    const cal = await oracle.calibrate(10);
    assert.equal(cal.ok, true);
    assert.equal(cal.matched, 10);
    assert.equal(cal.total, 10);
    assert.equal(cal.flaky, false);
    assert.equal(cal.mode, 'deterministic');
    assert.equal(cal.confidence, 1);
    assert.equal(oracle.signature.kind, 'exception');
    assert.ok(oracle.signature.normalized.includes('exception:TypeError'));
    const baseline = oracle.stats.probes; // calibration used runOnce, not the cache

    const hit = await oracle.probeCandidate('payload has BUGMARK here');
    assert.equal(hit.reproduces, true);
    assert.equal(hit.cached, false);
    const again = await oracle.probeCandidate('payload has BUGMARK here');
    assert.equal(again.cached, true);
    assert.equal(again.reproduces, true);
    assert.equal(oracle.stats.probes, baseline + 1, 'same candidate must never execute twice');
    assert.equal(oracle.stats.cacheHits, 1);

    // fresh:true bypasses the cache — the final-verify stage relies on this
    const fresh = await oracle.probeCandidate('payload has BUGMARK here', {}, { fresh: true });
    assert.equal(fresh.cached, false);
    assert.equal(fresh.reproduces, true);
    assert.equal(oracle.stats.probes, baseline + 2, 'fresh probe must execute for real');

    const clean = await oracle.probeCandidate('completely clean input');
    assert.equal(clean.reproduces, false);
    assert.equal(clean.cached, false);
    assert.equal(oracle.stats.probes, baseline + 3);
  } finally {
    scratch.cleanup();
  }
});

test('calibrate: 4/6 -> flaky mode with badge + counts', async () => {
  const scratch = tempDir('minrepro-or-');
  try {
    const counter = join(scratch.dir, 'counter.txt');
    const script = write(scratch.dir, 'repro.js', `const fs = require('node:fs');
const C = ${JSON.stringify(counter)};
const n = fs.existsSync(C) ? +fs.readFileSync(C, 'utf8') : 0;
fs.writeFileSync(C, String(n + 1));
if (n < 4) { console.error('FLAKY_MARK transient'); process.exit(1); }
`);
    const oracle = new Oracle({ repro: script, inputText: 'x', inputName: 'input.json' });
    const cal = await oracle.calibrate(6);
    assert.equal(cal.ok, true);
    assert.equal(cal.flaky, true);
    assert.equal(cal.matched, 4);
    assert.equal(cal.total, 6);
    assert.equal(cal.mode, 'flaky');
    assert.equal(cal.confidence, 4 / 6);
    // the artifact badge must SAY SO (SPEC §9)
    const badge = confidenceBadge({ matched: cal.matched, total: cal.total, flaky: cal.flaky });
    assert.match(badge.line, /FLAKY MODE/);
    assert.match(badge.line, /4\/6 runs/);
    assert.equal(badge.deterministic, false);
  } finally {
    scratch.cleanup();
  }
});

test('probes run in a clean env: host secrets are invisible', async () => {
  const scratch = tempDir('minrepro-or-');
  try {
    const script = write(scratch.dir, 'repro.js', "process.stdout.write(JSON.stringify(Object.keys(process.env)));\n");
    const oracle = new Oracle({ repro: script, inputText: 'x', inputName: 'input.json' });
    process.env.MINREPRO_TEST_SECRET = 's3cr3t-value-do-not-leak';
    try {
      const { result } = await oracle.runOnce();
      assert.equal(result.code, 0);
      assert.ok(!result.stdout.includes('MINREPRO_TEST_SECRET'), 'secret leaked into the probe env');
      assert.ok(!result.stdout.includes('s3cr3t-value-do-not-leak'));
      assert.ok(result.stdout.includes('PATH'), 'allowlisted PATH must survive');
    } finally {
      delete process.env.MINREPRO_TEST_SECRET;
    }
  } finally {
    scratch.cleanup();
  }
});

test('timeout probes are killed cleanly and signified as hang', async () => {
  const scratch = tempDir('minrepro-or-');
  try {
    const script = write(scratch.dir, 'repro.js', 'setInterval(() => {}, 300);\n');
    const oracle = new Oracle({ repro: script, inputText: 'x', inputName: 'input.json', timeoutMs: 400 });
    const started = Date.now();
    const { result, signature } = await oracle.runOnce();
    assert.equal(result.timedOut, true);
    assert.equal(signature.kind, 'hang');
    assert.ok(Date.now() - started < 8000, 'timeout must fire promptly');
  } finally {
    scratch.cleanup();
  }
});

test('shell-command repro templates with {input} work through cmd.exe', async () => {
  const scratch = tempDir('minrepro-or-');
  try {
    const failJs = write(scratch.dir, 'fail.js', `const d = require('node:fs').readFileSync(process.argv[2], 'utf8');
if (d.includes('BUG')) { console.error('SHELLMARK boom'); process.exit(1); }
`);
    // NOTE: on Windows, cmd.exe templates must not embed quotes around
    // paths that contain spaces (cmd does not understand \" escapes);
    // `node` resolves through the allowlisted PATH and the fixture path
    // (under the OS temp dir) has no spaces.
    const template = `node "${failJs}" "{input}"`;
    const oracle = new Oracle({ repro: template, inputText: 'has BUG', inputName: 'in.txt' });
    const cal = await oracle.calibrate(2);
    assert.equal(cal.ok, true);
    assert.equal(cal.matched, 2);
    assert.equal(cal.mode, 'deterministic');
    assert.equal(oracle.signature.kind, 'exit-code');
    assert.equal(oracle.signature.normalized, 'exit:1\nSHELLMARK boom');
    // without the trigger it does not reproduce
    const probe = await oracle.probeCandidate('all clean');
    assert.equal(probe.reproduces, false);
  } finally {
    scratch.cleanup();
  }
});
