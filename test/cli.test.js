import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main, parseArgs } from '../src/cli.js';
import { BASE, runNode, tempDir, write } from './helpers.js';

const CLI = join(BASE, 'src', 'cli.js');

/** Run main() in-process with both output streams captured. */
async function mainCapture(args) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const code = await main(args, { stdout: (s) => { out.push(s); } });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test('cli --help exits 0 with usage', async () => {
  // the only process-level check: proves the real binary sets exit code 0
  const res = await runNode([CLI, '--help'], { cwd: BASE });
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('Usage:'));
  assert.ok(res.stdout.includes('minrepro run --repro'));
  assert.ok(res.stdout.includes('Exit codes:'));
});

test('cli --version exits 0', async () => {
  const res = await mainCapture(['--version']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^minrepro \d+\.\d+\.\d+/);
});

test('cli run without required args -> exit 2 with usage hint', async () => {
  const res = await mainCapture(['run']);
  assert.equal(res.code, 2);
  assert.ok(res.stderr.includes('run requires --repro and --input'));
  assert.ok(res.stderr.includes('Run `minrepro --help` for usage.'));
});

test('cli unknown command -> exit 2', async () => {
  const res = await mainCapture(['frobnicate']);
  assert.equal(res.code, 2);
  assert.ok(res.stderr.includes('unknown command: frobnicate'));
});

test('cli flag missing its value -> exit 2', async () => {
  const res = await mainCapture(['run', '--repro']);
  assert.equal(res.code, 2);
  assert.ok(res.stderr.includes('flag --repro requires a value'));
});

test('cli rejects unknown stages, non-positive budgets and missing files', async () => {
  const scratch = tempDir('minrepro-cli-');
  try {
    const inputPath = write(scratch.dir, 'input.json', '{"a":1}');
    const scriptPath = write(scratch.dir, 'repro.js', 'process.exit(0);\n');

    const badStage = await mainCapture(['run', '--repro', scriptPath, '--input', inputPath, '--stages', 'bogus']);
    assert.equal(badStage.code, 2);
    assert.ok(badStage.stderr.includes('unknown stage: bogus'));

    const badBudget = await mainCapture(['run', '--repro', scriptPath, '--input', inputPath, '--max-probes', '0']);
    assert.equal(badBudget.code, 2);
    assert.ok(badBudget.stderr.includes('--max-probes must be a positive number'));

    const missingInput = await mainCapture(['run', '--repro', scriptPath, '--input', join(scratch.dir, 'nope.json')]);
    assert.equal(missingInput.code, 2);
    assert.ok(missingInput.stderr.includes('input file not found'));
  } finally {
    scratch.cleanup();
  }
});

test('parseArgs parses values, flags, positionals and -n shorthands', () => {
  const { flags, positional } = parseArgs([
    'run', '--repro', 'a.js', '--input', 'b.json', '--quiet', '-n5', '--stages', 'input,code', '--keep-temp',
  ]);
  assert.deepEqual(positional, ['run']);
  assert.equal(flags.repro, 'a.js');
  assert.equal(flags.input, 'b.json');
  assert.equal(flags.quiet, true);
  assert.equal(flags.runs, '5');
  assert.equal(flags.stages, 'input,code');
  assert.equal(flags['keep-temp'], true);

  assert.equal(parseArgs(['-n', '7']).flags.runs, '7');
  assert.equal(parseArgs(['--help']).flags.help, true);
  assert.equal(parseArgs(['-h']).flags.help, true);
  assert.equal(parseArgs(['--version']).flags.version, true);
  assert.throws(() => parseArgs(['--repro']), /requires a value/);
});

test('main() honors an injected stdout sink for --help', async () => {
  let captured = '';
  const code = await main(['--help'], { stdout: (s) => { captured += s; } });
  assert.equal(code, 0);
  assert.ok(captured.includes('Usage:'));
  const version = await main(['--version'], { stdout: (s) => { captured += s; } });
  assert.equal(version, 0);
});

test('main() returns 2 for a bare run with no flags', async () => {
  const res = await mainCapture(['run']);
  assert.equal(res.code, 2);
  assert.equal(await main([]), 0); // no command -> help, exit 0
});

test('cli run e2e: pipeline wiring -> exit 0, artifacts written', async () => {
  const scratch = tempDir('minrepro-cli-');
  try {
    const inputPath = write(scratch.dir, 'input.json', JSON.stringify({ junk: true, payload: 'CLI_MARK' }, null, 2));
    const scriptPath = write(scratch.dir, 'repro.js', `const d = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (d.payload === 'CLI_MARK') throw new Error('CLI_MARK exploded');
`);
    const outDir = join(scratch.dir, 'repro-out');
    const res = await mainCapture([
      'run', '--repro', scriptPath, '--input', inputPath,
      '--stages', 'input', '--calibration', '1', '--verify', '1',
      '--out', outDir, '--quiet',
    ]);
    assert.equal(res.code, 0, `cli run failed: ${res.stdout}${res.stderr}`);
    assert.ok(res.stdout.includes('final verify 1/1'));
    assert.ok(res.stdout.includes('Artifacts:'));
    assert.ok(existsSync(join(outDir, 'report.md')));
    const meta = JSON.parse(readFileSync(join(outDir, 'repro.json'), 'utf8'));
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.stages.input.strategy, 'json-shrink');
  } finally {
    scratch.cleanup();
  }
});

test('cli run e2e: non-reproducing script -> exit 3 with report.md', async () => {
  const scratch = tempDir('minrepro-cli-');
  try {
    const inputPath = write(scratch.dir, 'input.json', '{"a":1}');
    const scriptPath = write(scratch.dir, 'repro.js', 'process.exit(0);\n');
    const outDir = join(scratch.dir, 'repro-out');
    const res = await mainCapture([
      'run', '--repro', scriptPath, '--input', inputPath,
      '--calibration', '1', '--verify', '1', '--out', outDir, '--quiet',
    ]);
    assert.equal(res.code, 3);
    assert.ok(res.stdout.includes('Artifacts written to'));
    assert.ok(existsSync(join(outDir, 'report.md')));
  } finally {
    scratch.cleanup();
  }
});

test('cli verify on a non-artifact directory -> exit 2', async () => {
  const scratch = tempDir('minrepro-cli-');
  try {
    const res = await mainCapture(['verify', scratch.dir]);
    assert.equal(res.code, 2);
    assert.ok(res.stderr.includes('no repro.json'));

    const missing = await mainCapture(['verify', join(scratch.dir, 'does-not-exist')]);
    assert.equal(missing.code, 2);
    assert.ok(missing.stderr.includes('no repro.json'));
  } finally {
    scratch.cleanup();
  }
});

test('cli bisect requires --repo and --range', async () => {
  const res = await mainCapture(['bisect']);
  assert.equal(res.code, 2);
  assert.ok(res.stderr.includes('bisect requires --repo and --range'));
});
