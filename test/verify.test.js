/**
 * verify.test.js — verify ×N must be N REAL probe runs. Probe verdicts are
 * cached by the oracle; a cached loop turns "verify -n 10" into one execution
 * and can certify a flaky bug off a single lucky replay (exit-code contract:
 * 0 verified / 1 flaky / 3 not verified). This file would catch a regression
 * to the cached loop: the fake exec counts actual child launches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

const SCRIPT = 'process.exit(process.env.BUG_GATE === \'on\' ? 1 : 0);\n';
// What failureSignature produces for {code:1, stderr:'Error: boom'}:
// kind 'exit-code', normalized `exit:1\n` + first output line (see signature.js).
const SIG = { kind: 'exit-code', normalized: 'exit:1\nError: boom' };

function artifactDir(t, { extraEnv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'minrepro-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'repro.js'), SCRIPT);
  writeFileSync(join(dir, 'input.min.json'), '{"payload":"TRIGGER_VALUE"}\n');
  writeFileSync(join(dir, 'repro.json'), JSON.stringify({
    tool: 'minrepro', version: '0.1.0',
    exitCode: 0,
    signature: SIG,
    extraEnv: extraEnv ?? null,
    files: { script: 'repro.js', input: 'input.min.json' },
  }));
  return dir;
}

test('verify runs the oracle N real times (no cached verdicts) and maps to exit 1 when flaky', async (t) => {
  const dir = artifactDir(t);
  const real = [];
  // 2 of 4 real runs reproduce; 2 don't — a flaky bug. A cached (buggy) loop
  // would have collapsed to whatever the first run returned.
  let spawned = 0;
  const fakeExec = async (file, args, opts) => {
    spawned += 1;
    real.push({ file, args, opts });
    return { code: spawned % 2 === 1 ? 1 : 0, signal: null, stdout: '', stderr: spawned % 2 === 1 ? 'Error: boom\n' : '', timedOut: false };
  };
  const lines = [];
  const code = await main(['verify', dir, '-n', '4', '--timeout', '5000'], {
    stdout: (s) => lines.push(s),
    stderr: (s) => lines.push(s),
    exec: fakeExec,
  });
  assert.equal(code, 1, 'flaky (matched < total) must map to exit 1');
  assert.equal(spawned, 4, 'each of the 4 verification runs must exec once — cached loops run only once');
  assert.match(lines.join('\n'), /reproduced 2\/4/);
});

test('verify maps a fully reproduced artifact to exit 0 with one real run per -n', async (t) => {
  const dir = artifactDir(t);
  let spawned = 0;
  const fakeExec = async () => {
    spawned += 1;
    return { code: 1, signal: null, stdout: '', stderr: 'Error: boom\n', timedOut: false };
  };
  const code = await main(['verify', dir, '-n', '5', '--timeout', '5000'], {
    stdout: () => {}, stderr: () => {}, exec: fakeExec,
  });
  assert.equal(code, 0, 'matched === runs must map to exit 0');
  assert.equal(spawned, 5);
});

test('verify on a dir with repro.json but missing script/input is a usage error (exit 2)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'minrepro-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'repro.json'), JSON.stringify({
    tool: 'minrepro', signature: null, extraEnv: null,
    files: { script: 'gone.js', input: 'gone.json' },
  }));
  const err = [];
  const code = await main(['verify', dir, '-n', '2'], {
    stdout: () => {}, stderr: (s) => err.push(s),
  });
  assert.equal(code, 2, 'missing artifact files are a usage problem, not "non-reproducible"');
  assert.match(err.join('\n'), /missing/);
});
