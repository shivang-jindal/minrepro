import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { ENV_ALLOWLIST, cleanEnv, exec, scratchDir } from '../src/exec.js';
import { runNode } from './helpers.js';

test('exec runs a command and captures stdout/stderr and exit code', async () => {
  const ok = await exec(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, 'hi');
  assert.equal(ok.timedOut, false);
  assert.ok(typeof ok.durationMs === 'number' && ok.durationMs >= 0);

  const bad = await exec(process.execPath, ['-e', 'console.error("x"); process.exit(7)']);
  assert.equal(bad.code, 7);
  assert.match(bad.stderr, /x/);
});

test('cleanEnv keeps only allowlisted vars plus explicit extras', () => {
  const env = cleanEnv({ EXTRA: 'v' });
  assert.equal(env.EXTRA, 'v');
  assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0);
  for (const key of Object.keys(env)) {
    const matched = ENV_ALLOWLIST.some((a) => a.toLowerCase() === key.toLowerCase())
      || key === 'EXTRA';
    assert.ok(matched, `unexpected env var survived cleanEnv: ${key}`);
  }
});

test('cleanEnv strips host secrets and stringifies values', () => {
  process.env.MINREPRO_EXEC_SECRET = 'top-secret';
  try {
    const env = cleanEnv({ NUM: 42, NIL: null, UNDEF: undefined });
    assert.ok(!('MINREPRO_EXEC_SECRET' in env));
    assert.equal(env.NUM, '42');
    assert.ok(!('NIL' in env));
    assert.ok(!('UNDEF' in env));
  } finally {
    delete process.env.MINREPRO_EXEC_SECRET;
  }
});

test('exec runs in an explicit temp cwd', async () => {
  const scratch = scratchDir('minrepro-exec-');
  try {
    const res = await exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: scratch.dir });
    assert.equal(res.code, 0);
    assert.equal(resolve(res.stdout).toLowerCase(), resolve(scratch.dir).toLowerCase());
  } finally {
    scratch.cleanup();
  }
});

test('exec kills a runaway process at the timeout', async () => {
  const started = Date.now();
  const res = await exec(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { timeoutMs: 400 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - started < 8000, 'kill must happen promptly');
});

test('exec caps captured output', async () => {
  const script = 'for (let i = 0; i < 32; i++) process.stdout.write("x".repeat(65536));';
  const res = await exec(process.execPath, ['-e', script], { timeoutMs: 15000 });
  const MAX = 512 * 1024;
  assert.ok(res.stdout.length >= MAX, `cap not reached: ${res.stdout.length}`);
  assert.ok(res.stdout.length <= MAX + 128 * 1024, `cap leaked: ${res.stdout.length}`);
});

test('exec round-trips stdin input', async () => {
  const echo = 'let d = ""; process.stdin.on("data", (c) => { d += c; }); '
    + 'process.stdin.on("end", () => process.stdout.write(d));';
  const res = await exec(process.execPath, ['-e', echo], { input: 'ping-pong' });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'ping-pong');
});

test('scratchDir creates under the OS temp dir and cleans up', () => {
  const scratch = scratchDir('minrepro-scratch-test-');
  assert.ok(existsSync(scratch.dir));
  // os.tmpdir() is the portability-correct source: %TEMP%/%TMP% are Windows
  // only and undefined on POSIX runners (they used to crash this assertion).
  const tmp = os.tmpdir().replace(/[\\/]+\$/, '').toLowerCase();
  const dir = scratch.dir.replace(/[\\/]+\$/, '').toLowerCase();
  assert.ok(dir.startsWith(tmp), 'scratch dir not under tmpdir: ' + scratch.dir);
  scratch.cleanup();
  assert.ok(!existsSync(scratch.dir));
});

test('exec on a missing binary resolves with an error message instead of throwing', async () => {
  const res = await exec('definitely-not-a-real-binary-minrepro', [], {});
  assert.equal(res.code, null);
  assert.ok(res.stderr.length > 0);
});
