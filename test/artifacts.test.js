import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAfterRows, confidenceBadge, renderReport, writeArtifacts } from '../src/artifacts.js';
import { tempDir } from './helpers.js';

function fullState(extra = {}) {
  return {
    title: 'acme/sdk#4471',
    exitCode: 0,
    calibration: { total: 10, matched: 10, flaky: false, mode: 'deterministic', confidence: 1 },
    signature: { kind: 'exception', normalized: 'exception:Error\nboom\nexit:1', raw: 'x' },
    stages: {
      input: {
        strategy: 'json-shrink',
        before: { bytes: 842, chars: 842 }, after: { bytes: 12, chars: 12 },
        probes: 31, accepted: 12, exhausted: false,
      },
      code: { before: { lines: 1204 }, after: { lines: 47 }, probes: 61, syntaxRejected: 3 },
      env: { before: { count: 41 }, after: { count: 2 }, probes: 20 },
    },
    minimizedScript: 'boom();',
    minimizedInput: '{"payload":1}',
    finalVerify: { total: 10, matched: 10 },
    stageLog: ['[calibrate] 10/10', '[input] ok'],
    budgetNotes: ['input stage: budget exhausted (probe budget exhausted (2)); 3 next candidate(s) listed in repro.json'],
    bisect: {
      status: 'culprit',
      culprit: { short: '9c1f2ab', subject: 'refactor: stream pipeline', date: '2026-10-02' },
      verified: { runs: 3, total: 3 }, commits: 214, range: 'v1..main',
    },
    extraEnv: {},
    ...extra,
  };
}

test('confidenceBadge: deterministic / flaky / could-not / uncalibrated', () => {
  assert.equal(confidenceBadge(null).line, '**Confidence:** not calibrated');
  const det = confidenceBadge({ matched: 10, total: 10, flaky: false });
  assert.equal(det.line, '**Confidence:** 10/10 runs · deterministic ✅');
  assert.equal(det.deterministic, true);
  const flaky = confidenceBadge({ matched: 4, total: 10, flaky: true });
  assert.match(flaky.line, /⚠️ FLAKY MODE — reproduced 4\/10 runs/);
  assert.equal(flaky.deterministic, false);
  const none = confidenceBadge({ matched: 1, total: 10, flaky: false });
  assert.match(none.line, /❌ could not reproduce \(1\/10 runs\)/);
});

test('beforeAfterRows renders every stage with strategy labels', () => {
  const rows = beforeAfterRows(fullState());
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], 'input (json-shrink)');
  assert.equal(rows[0][1], '842 B (842 chars)');
  assert.equal(rows[0][2], '12 B (12 chars)');
  assert.equal(rows[0][3], '31 probes (12 accepted)');
  assert.equal(rows[1][0], 'repro script');
  assert.equal(rows[1][3], '61 probes, 3 syntax-rejected');
  assert.equal(rows[2][0], 'env vars (removable)');
});

test('renderReport contains badge, tables, signature, culprit, verify, budgets, stage log', () => {
  const report = renderReport(fullState());
  assert.match(report, /^# Reproduction: acme\/sdk#4471/);
  assert.ok(report.includes('**Confidence:** 10/10 runs · deterministic ✅'));
  assert.ok(report.includes('## Minimal reproduction (1 lines, was 1204)'));
  assert.ok(report.includes('## What we removed'));
  assert.ok(report.includes('| input (json-shrink) | 842 B (842 chars) | 12 B (12 chars) | 31 probes (12 accepted) |'));
  assert.ok(report.includes('| repro script | 1204 lines | 47 lines | 61 probes, 3 syntax-rejected |'));
  assert.ok(report.includes('| env vars (removable) | 41 | 2 | 20 probes |'));
  assert.ok(report.includes('## Failure signature (normalized)'));
  assert.ok(report.includes('exception:Error'));
  assert.ok(report.includes('## Culprit commit'));
  assert.ok(report.includes('`9c1f2ab "refactor: stream pipeline"` (2026-10-02) — verified at 3/3 probes'));
  assert.ok(report.includes('narrowed from 214 commits'));
  assert.ok(report.includes('## Final verification'));
  assert.ok(report.includes('Minimized artifact reproduced 10/10 runs.'));
  assert.ok(report.includes('## Run it'));
  assert.ok(report.includes('## Budget & honesty notes'));
  assert.ok(report.includes('budget exhausted'));
  assert.ok(report.includes('## Stage log'));
  assert.ok(report.includes('[calibrate] 10/10'));
  assert.ok(report.includes('exit code 0 = repro produced and verified (deterministic)'));
});

test('renderReport badges flaky and non-culprit bisect outcomes honestly', () => {
  const flaky = renderReport(fullState({
    exitCode: 1,
    calibration: { total: 10, matched: 4, flaky: true, mode: 'flaky', confidence: 0.4 },
  }));
  assert.ok(flaky.includes('⚠️ FLAKY MODE — reproduced 4/10 runs'));
  assert.ok(flaky.includes('Everything below inherits that uncertainty.'));
  assert.ok(flaky.includes('exit code 1 = partial'));

  const fixed = renderReport(fullState({
    bisect: { status: 'already-fixed', message: 'oracle does not reproduce at either end of v1..HEAD' },
  }));
  assert.ok(fixed.includes('Bisect outcome: **already-fixed**'));
  assert.ok(fixed.includes('oracle does not reproduce at either end'));

  const failed = renderReport(fullState({ exitCode: 3, calibration: { total: 10, matched: 0, flaky: false } }));
  assert.ok(failed.includes('exit code 3 = could not reproduce'));
});

test('writeArtifacts writes the full repro/ file set', () => {
  const scratch = tempDir('minrepro-art-');
  try {
    const outDir = join(scratch.dir, 'repro');
    const state = fullState({ extraEnv: { BUG_GATE: 'on' } });
    const written = writeArtifacts({ outDir, state, inputExt: '.json' });
    assert.equal(written.dir, outDir);
    assert.deepEqual(written.files, [
      'input.min.json', 'repro.js', 'run.sh', 'run.cmd', 'report.md', 'repro.json',
    ]);
    assert.equal(readFileSync(join(outDir, 'input.min.json'), 'utf8'), '{"payload":1}');
    assert.equal(readFileSync(join(outDir, 'repro.js'), 'utf8'), 'boom();');
    const runSh = readFileSync(join(outDir, 'run.sh'), 'utf8');
    assert.ok(runSh.includes('exec node repro.js "input.min.json"'));
    const runCmd = readFileSync(join(outDir, 'run.cmd'), 'utf8');
    assert.ok(runCmd.includes('node repro.js "input.min.json"'));
    assert.ok(readFileSync(join(outDir, 'report.md'), 'utf8').includes('# Reproduction: acme/sdk#4471'));
  } finally {
    scratch.cleanup();
  }
});

test('repro.json round-trips machine state including extraEnv', () => {
  const scratch = tempDir('minrepro-art-');
  try {
    const outDir = join(scratch.dir, 'repro');
    const state = fullState({ extraEnv: { BUG_GATE: 'on' } });
    writeArtifacts({ outDir, state, inputExt: '.txt' });
    const meta = JSON.parse(readFileSync(join(outDir, 'repro.json'), 'utf8'));
    assert.equal(meta.tool, 'minrepro');
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.title, 'acme/sdk#4471');
    assert.equal(meta.files.script, 'repro.js');
    assert.equal(meta.files.input, 'input.min.txt');
    assert.deepEqual(meta.stages, state.stages);
    assert.deepEqual(meta.calibration, state.calibration);
    assert.deepEqual(meta.finalVerify, { total: 10, matched: 10 });
    assert.deepEqual(meta.extraEnv, { BUG_GATE: 'on' });
    // artifact set must be byte-identical across runs — no timestamps anywhere
    assert.equal(meta.createdAt, undefined);
    assert.ok(meta.bisect.status === 'culprit');
  } finally {
    scratch.cleanup();
  }
});
