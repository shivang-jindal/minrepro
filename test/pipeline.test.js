import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRepro, detectJson, runPipeline } from '../src/pipeline.js';
import { BASE, E2E_SCRIPT, noisyJson, run, runNode, tempDir, write } from './helpers.js';

function fakeNoiseEnv(n = 3) {
  const env = {};
  for (let i = 0; i < n; i++) env[`NOISE_VAR_${i}`] = `noise value ${i}`;
  return env;
}

test('pipeline e2e: noisy JSON + repro script -> full repro/ artifacts, exit 0', async () => {
  const scratch = tempDir('minrepro-pipe-');
  try {
    const inputPath = write(scratch.dir, 'input.json', noisyJson());
    const scriptPath = write(scratch.dir, 'repro.js', E2E_SCRIPT);
    const outDir = join(scratch.dir, 'repro');
    const lines = [];
    const { exitCode, state } = await runPipeline({
      repro: scriptPath,
      input: inputPath,
      outDir,
      env: fakeNoiseEnv(3),
      calibrationRuns: 2,
      verifyRuns: 2,
      quiet: true,
      sink: (s) => lines.push(s),
    });

    assert.equal(exitCode, 0);
    assert.equal(state.calibration.matched, 2);
    assert.equal(state.calibration.mode, 'deterministic');
    assert.deepEqual(state.finalVerify, { total: 2, matched: 2 });

    // input shrunk to the EXACT structural minimum
    assert.equal(state.stages.input.strategy, 'json-shrink');
    assert.deepEqual(JSON.parse(state.minimizedInput), { level1: { payload: 'TRIGGER_VALUE' } });
    assert.ok(state.stages.input.after.bytes < state.stages.input.before.bytes);

    // code minimized but the failing line survives (stack-protected)
    assert.ok(state.stages.code.after.lines < state.stages.code.before.lines);
    assert.ok(state.stages.code.after.lines <= 4, `code not minimal: ${state.stages.code.after.lines} lines`);
    assert.ok(state.stages.code.protectedLines.includes(5));
    assert.ok(state.minimizedScript.includes('E2E_MARK'));
    assert.ok(state.minimizedScript.includes('dead1') === false, 'dead lines must be gone');

    // env: nothing needed -> all removable noise vars dropped
    assert.equal(state.stages.env.before.count, 3);
    assert.equal(state.stages.env.after.count, 0);
    assert.deepEqual(state.stages.env.after.names, []);
    assert.ok(state.stages.env.probes > 0);

    assert.equal(state.probeStats.calibrationProbes, 2);

    // ---- artifacts ----
    for (const f of ['report.md', 'repro.json', 'run.sh', 'run.cmd', 'repro.js', 'input.min.json']) {
      assert.ok(existsSync(join(outDir, f)), `missing artifact: ${f}`);
    }
    const report = readFileSync(join(outDir, 'report.md'), 'utf8');
    assert.ok(report.includes('**Confidence:** 2/2 runs · deterministic ✅'));
    assert.ok(report.includes('| input (json-shrink) |'));
    assert.ok(report.includes('| repro script |'));
    assert.ok(report.includes('| env vars (removable) | 3 | 0 |'));
    assert.ok(report.includes('Minimized artifact reproduced 2/2 runs.'));
    for (const marker of ['[calibrate]', '[input]', '[code]', '[env]', '[verify]']) {
      assert.ok(report.includes(marker), `stage log missing ${marker}`);
    }
    assert.ok(!report.includes('## Budget & honesty notes'), 'no budget pressure expected here');
    assert.ok(report.includes('exit code 0 = repro produced and verified (deterministic)'));

    const meta = JSON.parse(readFileSync(join(outDir, 'repro.json'), 'utf8'));
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.stages.input.strategy, 'json-shrink');
    assert.deepEqual(meta.finalVerify, { total: 2, matched: 2 });

    // the artifact is self-contained: run.cmd exits nonzero = bug present
    const cmdRes = await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'run.cmd'], { cwd: outDir });
    assert.ok(cmdRes.code !== null, `cmd.exe failed to start: ${cmdRes.stderr}`);
    assert.ok(cmdRes.code !== 0, 'artifact run.cmd must exit nonzero (bug present)');
    assert.ok(cmdRes.stderr.includes('E2E_MARK'));

    assert.ok(lines.some((l) => l.includes('final verify 2/2')), 'progress summary not logged');
  } finally {
    scratch.cleanup();
  }
});

test('pipeline: tiny --max-probes -> honest partial result, exit 1', async () => {
  const scratch = tempDir('minrepro-pipe-');
  try {
    const inputPath = write(scratch.dir, 'input.json', noisyJson());
    const scriptPath = write(scratch.dir, 'repro.js', E2E_SCRIPT);
    const outDir = join(scratch.dir, 'repro');
    const { exitCode, state } = await runPipeline({
      repro: scriptPath,
      input: inputPath,
      outDir,
      env: fakeNoiseEnv(2),
      stages: ['input'],
      maxProbes: 2,
      calibrationRuns: 2,
      verifyRuns: 2,
      quiet: true,
    });
    assert.equal(exitCode, 1);
    assert.equal(state.stages.input.exhausted, true);
    assert.match(state.stages.input.exhaustedReason, /probe budget exhausted/);
    assert.ok(state.stages.input.nextCandidates.length > 0);

    const report = readFileSync(join(outDir, 'report.md'), 'utf8');
    assert.ok(report.includes('## Budget & honesty notes'));
    assert.ok(report.includes('input stage: budget exhausted'));
    const meta = JSON.parse(readFileSync(join(outDir, 'repro.json'), 'utf8'));
    assert.equal(meta.stages.input.exhausted, true);
    assert.equal(meta.exitCode, 1);
    // final verify still ran on the (partially minimized) artifact
    assert.deepEqual(state.finalVerify, { total: 2, matched: 2 });
  } finally {
    scratch.cleanup();
  }
});

test('pipeline: cannot reproduce -> exit 3 with an explaining report', async () => {
  const scratch = tempDir('minrepro-pipe-');
  try {
    const inputPath = write(scratch.dir, 'input.json', noisyJson());
    const scriptPath = write(scratch.dir, 'repro.js', 'process.exit(0);\n');
    const outDir = join(scratch.dir, 'repro');
    const { exitCode, state } = await runPipeline({
      repro: scriptPath,
      input: inputPath,
      outDir,
      env: fakeNoiseEnv(2),
      stages: ['input'],
      calibrationRuns: 3,
      verifyRuns: 1,
      quiet: true,
    });
    assert.equal(exitCode, 3);
    assert.equal(state.calibration.matched, 0);
    assert.ok(state.note.includes('could not reproduce'));
    const report = readFileSync(join(outDir, 'report.md'), 'utf8');
    assert.ok(report.includes('❌ could not reproduce (0/3 runs)'));
    assert.ok(report.includes('exit code 3 = could not reproduce'));
  } finally {
    scratch.cleanup();
  }
});

test('pipeline: env-gated bug -> launch-env fallback, env stage isolates the gate var', async () => {
  const scratch = tempDir('minrepro-pipe-');
  try {
    const inputPath = write(scratch.dir, 'input.json', JSON.stringify({ note: 'GATE_INPUT here' }, null, 2));
    const scriptPath = write(scratch.dir, 'repro.js', `const raw = require('node:fs').readFileSync(process.argv[2], 'utf8');
const dead = 41;
if (process.env.BUG_GATE === 'on' && raw.includes('GATE_INPUT')) {
  throw new Error('GATED_MARK: env-gated explosion');
}
`);
    const outDir = join(scratch.dir, 'repro');
    const env = { BUG_GATE: 'on', NOISE_0: 'n0', NOISE_1: 'n1', NOISE_2: 'n2' };

    const { exitCode, state } = await runPipeline({
      repro: scriptPath,
      input: inputPath,
      outDir,
      env,
      stages: ['env'],
      calibrationRuns: 2,
      verifyRuns: 1,
      quiet: true,
    });
    assert.equal(exitCode, 0);
    assert.ok(state.stageLog.some((l) => l.includes('reproduced with launch environment')));
    assert.ok(state.stageLog.some((l) => l.includes('bug appears env-gated')));
    // exactly the gating var survives env minimization
    assert.equal(state.stages.env.before.count, 4);
    assert.deepEqual(state.stages.env.after.names, ['BUG_GATE']);
    assert.deepEqual(state.extraEnv, { BUG_GATE: 'on' });
    assert.deepEqual(state.finalVerify, { total: 1, matched: 1 });

    const report = readFileSync(join(outDir, 'report.md'), 'utf8');
    assert.ok(report.includes('reproduced with launch environment'));
    assert.ok(report.includes('| env vars (removable) | 4 | 1 |'));
    // the artifact persists the minimized env so `minrepro verify` replays it
    const meta = JSON.parse(readFileSync(join(outDir, 'repro.json'), 'utf8'));
    assert.deepEqual(meta.extraEnv, { BUG_GATE: 'on' });
    const verify = await runNode([join(BASE, 'src', 'cli.js'), 'verify', outDir, '-n', '1'], { cwd: BASE });
    assert.equal(verify.code, 0, `verify failed: ${verify.stdout}${verify.stderr}`);
    assert.ok(verify.stdout.includes('reproduced 1/1 runs'));
  } finally {
    scratch.cleanup();
  }
});

test('classifyRepro and detectJson classify inputs correctly', () => {
  const s = classifyRepro('C:\\proj\\a b\\repro.js');
  assert.equal(s.kind, 'script');
  assert.equal(s.basename, 'repro.js');
  assert.equal(classifyRepro('/home/u/repro.mjs').kind, 'script');
  assert.equal(classifyRepro('node foo.js --flag {input}').kind, 'shell');
  assert.equal(classifyRepro('npm test').kind, 'shell');

  assert.equal(detectJson('{"a":1}'), true);
  assert.equal(detectJson('  [1, 2, 3]  '), true);
  assert.equal(detectJson('plain text'), false);
  assert.equal(detectJson('{ broken json'), false);
});
