// report-format.test.js — `--report-format md|json` on `run`.
//
// md (default) keeps writing report.md unchanged; json writes report.json
// ({title, signature, stages, confidence, exitCode}) and keeps report.md OFF.
// The e2e pipeline fixture (noisy JSON + E2E_SCRIPT) is reused so the stage
// counts are real minimization results, not hand-rolled state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import { BASE, E2E_SCRIPT, noisyJson, runNode, tempDir, write } from './helpers.js';

const CLI = join(BASE, 'src', 'cli.js');

function fakeNoiseEnv(n = 3) {
  const env = {};
  for (let i = 0; i < n; i++) env[`NOISE_VAR_${i}`] = `noise value ${i}`;
  return env;
}

const PIPELINE_ARGS = { calibrationRuns: 2, verifyRuns: 2, quiet: true };

test('report-format json: report.json parses with {title, signature, stages, confidence, exitCode}', async () => {
  const scratch = tempDir('minrepro-rf-json-');
  try {
    const inputPath = write(scratch.dir, 'input.json', noisyJson());
    const scriptPath = write(scratch.dir, 'repro.js', E2E_SCRIPT);
    const outDir = join(scratch.dir, 'repro');
    const { exitCode, state } = await runPipeline({
      ...PIPELINE_ARGS,
      repro: scriptPath,
      input: inputPath,
      outDir,
      env: fakeNoiseEnv(3),
      title: 'acme/sdk#4471',
      reportFormat: 'json',
    });
    assert.equal(exitCode, 0);

    // report.md is OFF in json mode; report.json is on
    assert.ok(existsSync(join(outDir, 'report.json')), 'report.json must exist');
    assert.ok(!existsSync(join(outDir, 'report.md')), 'report.md must stay OFF in json mode');

    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    assert.deepEqual(Object.keys(report).sort(), [
      'confidence', 'exitCode', 'signature', 'stages', 'title',
    ]);
    assert.equal(report.title, 'acme/sdk#4471');
    assert.equal(report.exitCode, 0);
    assert.equal(report.signature.kind, 'exception');
    assert.deepEqual(report.confidence, {
      matched: 2, total: 2, flaky: false, mode: 'deterministic',
    });

    // stage counts match the minimized stages from the same run's state
    assert.deepEqual(report.stages.map((s) => s.name), ['input', 'code', 'env']);
    const byName = Object.fromEntries(report.stages.map((s) => [s.name, s]));
    assert.equal(byName.input.before, state.stages.input.before.bytes);
    assert.equal(byName.input.after, state.stages.input.after.bytes);
    assert.ok(byName.input.after < byName.input.before, 'input must shrink');
    assert.equal(byName.code.before, state.stages.code.before.lines);
    assert.equal(byName.code.after, state.stages.code.after.lines);
    assert.ok(byName.code.after < byName.code.before, 'code must shrink');
    assert.equal(byName.env.before, 3);
    assert.equal(byName.env.after, 0);
    for (const s of report.stages) {
      assert.equal(typeof s.accepted, 'number', `${s.name} accepted must be a number`);
    }
    // byte-identical across identical runs (no timestamps in report.json)
    const again = join(scratch.dir, 'repro2');
    await runPipeline({
      ...PIPELINE_ARGS,
      repro: scriptPath,
      input: inputPath,
      outDir: again,
      env: fakeNoiseEnv(3),
      title: 'acme/sdk#4471',
      reportFormat: 'json',
    });
    assert.equal(
      readFileSync(join(outDir, 'report.json'), 'utf8'),
      readFileSync(join(again, 'report.json'), 'utf8'),
      'report.json must be byte-identical across identical runs',
    );
  } finally {
    scratch.cleanup();
  }
});

test('report-format md (default): report.md unchanged, no report.json', async () => {
  const scratch = tempDir('minrepro-rf-md-');
  try {
    const inputPath = write(scratch.dir, 'input.json', noisyJson());
    const scriptPath = write(scratch.dir, 'repro.js', E2E_SCRIPT);
    const outDir = join(scratch.dir, 'repro');
    const { exitCode } = await runPipeline({
      ...PIPELINE_ARGS,
      repro: scriptPath,
      input: inputPath,
      outDir,
      env: fakeNoiseEnv(3),
    });
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(outDir, 'report.md')), 'default keeps report.md');
    assert.ok(!existsSync(join(outDir, 'report.json')), 'default writes no report.json');
    const report = readFileSync(join(outDir, 'report.md'), 'utf8');
    assert.ok(report.includes('**Confidence:** 2/2 runs · deterministic ✅'));
    assert.ok(report.includes('| input (json-shrink) |'));
  } finally {
    scratch.cleanup();
  }
});

test('cli --report-format json: wires through run and skips report.md', async () => {
  const scratch = tempDir('minrepro-rf-cli-');
  try {
    const inputPath = write(scratch.dir, 'input.json', JSON.stringify({ junk: true, payload: 'RF_MARK' }, null, 2));
    const scriptPath = write(scratch.dir, 'repro.js', `const d = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (d.payload === 'RF_MARK') throw new Error('RF_MARK exploded');
`);
    const outDir = join(scratch.dir, 'repro-out');
    const res = await runNode([
      CLI, 'run', '--repro', scriptPath, '--input', inputPath,
      '--stages', 'input', '--calibration', '1', '--verify', '1',
      '--out', outDir, '--report-format', 'json', '--quiet',
    ], { cwd: BASE });
    assert.equal(res.code, 0, `cli run failed: ${res.stdout}${res.stderr}`);
    assert.ok(existsSync(join(outDir, 'report.json')));
    assert.ok(!existsSync(join(outDir, 'report.md')));
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.exitCode, 0);
    assert.equal(report.stages.length, 1);
    assert.equal(report.stages[0].name, 'input');
    assert.deepEqual(report.confidence, { matched: 1, total: 1, flaky: false, mode: 'deterministic' });
  } finally {
    scratch.cleanup();
  }
});

test('cli: invalid --report-format is a usage error (exit 2)', async () => {
  const res = await runNode([
    CLI, 'run', '--repro', 'repro.js', '--input', 'input.json', '--report-format', 'yaml',
  ], { cwd: BASE });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--report-format must be md or json/);
});
