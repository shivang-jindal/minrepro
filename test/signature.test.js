import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, parseFrames, parseErrorHead, failureSignature, sameFailure, isScriptFrame,
} from '../src/signature.js';

test('normalizeText templates Windows absolute paths', () => {
  assert.equal(
    normalizeText('at boom (C:\\Users\\alice\\proj\\src\\store.js:12:3)'),
    'at boom (<PATH>:12:3)',
  );
});

test('normalizeText templates POSIX absolute paths', () => {
  assert.equal(normalizeText('opened /home/bob/app/lib/util.js for reading'), 'opened <PATH> for reading');
});

test('normalizeText templates UUIDs, ISO timestamps, unix-ms and hex ids', () => {
  const s = 'req 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at 2026-10-02T10:11:12.123Z key deadbeefcafe ts 1760000000000';
  const out = normalizeText(s);
  assert.equal(out, 'req <UUID> at <TIME> key <HEX> ts <TIME>');
});

test('same bug with different absolute paths and line numbers -> identical signature', () => {
  const a = {
    code: 1, signal: null, timedOut: false, stdout: '',
    stderr: [
      'TypeError: cannot read field "id" of undefined',
      '    at loadUser (C:\\Users\\alice\\proj\\src\\store.js:88:15)',
      '    at run (C:\\Users\\alice\\proj\\src\\app.js:12:5)',
      '    at Object.<anonymous> (C:\\Users\\alice\\proj\\node_modules\\harness\\run.js:4:1)',
    ].join('\n'),
  };
  const b = {
    code: 1, signal: null, timedOut: false, stdout: '',
    stderr: [
      'TypeError: cannot read field "id" of undefined',
      '    at loadUser (D:\\work\\bug repro\\store.js:204:3)',
      '    at run (D:\\work\\bug repro\\app.js:77:21)',
      '    at Object.<anonymous> (D:\\work\\bug repro\\node_modules\\harness\\run.js:9:9)',
    ].join('\n'),
  };
  const sa = failureSignature(a);
  const sb = failureSignature(b);
  assert.equal(sa.kind, 'exception');
  assert.ok(sameFailure(sa, sb));
  assert.equal(sa.normalized, [
    'exception:TypeError',
    'cannot read field "id" of undefined',
    'at loadUser store.js',
    'at run app.js',
    'exit:1',
  ].join('\n'));
});

test('same bug with different UUIDs/hex ids/timestamps in message -> identical signature', () => {
  const mk = (uuid, hex, iso, ms) => ({
    code: 1, signal: null, timedOut: false, stdout: '',
    stderr: [
      `Error: request ${uuid} failed for key ${hex} at ${iso} after ${ms} ms`,
      '    at handler (/srv/api/routes.js:31:11)',
    ].join('\n'),
  });
  const a = mk('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'deadbeefcafe', '2026-10-02T10:11:12.123Z', 1760000000000);
  const b = mk('7c9e6679-7425-40de-944b-e07fc1f90ae7', '0badf00d1234', '2031-01-01 23:59:59', 1999999999999);
  assert.ok(sameFailure(failureSignature(a), failureSignature(b)));
});

test('exit code participates in the signature', () => {
  const base = { signal: null, timedOut: false, stdout: '', stderr: 'boom happened' };
  const a = failureSignature({ ...base, code: 1 });
  const b = failureSignature({ ...base, code: 2 });
  assert.equal(a.kind, 'exit-code');
  assert.equal(a.normalized, 'exit:1\nboom happened');
  assert.ok(!sameFailure(a, b));
});

test('nondeterministic failures produce distinct signatures (error class varies)', () => {
  const run1 = { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'TypeError: bad thing\n    at f (/a/b.js:1:1)' };
  const run2 = { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'ReferenceError: bad thing\n    at f (/a/b.js:1:1)' };
  assert.ok(!sameFailure(failureSignature(run1), failureSignature(run2)));
});

test('nondeterministic failures produce distinct signatures (volatile message content)', () => {
  const run1 = { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'timed out after 3021 ms' };
  const run2 = { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'timed out after 9876 ms' };
  assert.ok(!sameFailure(failureSignature(run1), failureSignature(run2)));
});

test('timeout -> kind "hang"; signal -> kind "signal"', () => {
  const hang = failureSignature({ code: null, signal: null, timedOut: true, stdout: '', stderr: '' });
  assert.equal(hang.kind, 'hang');
  assert.equal(hang.normalized, 'hang');
  const sig = failureSignature({ code: null, signal: 'SIGKILL', timedOut: false, stdout: '', stderr: '' });
  assert.equal(sig.kind, 'signal');
  assert.equal(sig.normalized, 'signal:SIGKILL');
});

test('parseFrames keeps user frames, drops node internals and node_modules', () => {
  const frames = parseFrames([
    '    at boom (C:\\work\\repo\\repro.js:3:9)',
    '    at Object.<anonymous> (C:\\work\\repo\\node_modules\\runner\\index.js:10:2)',
    '    at node:internal/main/run_main_module:24:10',
    '    at main (/home/user/app/main.js:5:1)',
  ].join('\n'));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].basename, 'repro.js');
  assert.equal(frames[0].fn, 'boom');
  assert.equal(frames[0].line, 3);
  assert.equal(frames[1].basename, 'main.js');
});

test('parseFrames handles bare file frames without a function name', () => {
  const frames = parseFrames('    at /srv/app/index.js:7:1');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].fn, '<anonymous>');
  assert.equal(frames[0].basename, 'index.js');
  assert.equal(frames[0].line, 7);
});

test('parseErrorHead extracts class + message, or message-only', () => {
  assert.deepEqual(parseErrorHead('TypeError: cannot read x\n    at f (a.js:1:1)'), { cls: 'TypeError', message: 'cannot read x' });
  assert.deepEqual(parseErrorHead('just some plain output'), { cls: null, message: 'just some plain output' });
  assert.equal(parseErrorHead('   \n  '), null);
});

test('real Node uncaught-error output (context block first) still yields an exception signature', () => {
  const realNodeOutput = [
    'C:\\Users\\bob\\proj\\repro.js:5',
    'if (data.includes(\'BUGMARK\')) {',
    '              ^',
    '',
    'TypeError: ORACLE_MARK exploded',
    '    at Object.<anonymous> (C:\\Users\\bob\\proj\\repro.js:5:15)',
    '    at Module._compile (node:internal/modules/cjs/loader:1929:14)',
  ].join('\n');
  const sig = failureSignature({ code: 1, signal: null, timedOut: false, stdout: '', stderr: realNodeOutput });
  assert.equal(sig.kind, 'exception');
  assert.equal(sig.normalized, [
    'exception:TypeError',
    'ORACLE_MARK exploded',
    'at Object.<anonymous> repro.js',
    'exit:1',
  ].join('\n'));
  // same bug from a different machine -> same signature
  const otherMachine = realNodeOutput
    .replaceAll('C:\\Users\\bob\\proj', 'D:\\ci\\agent-42\\work');
  assert.ok(sameFailure(sig, failureSignature({ code: 1, signal: null, timedOut: false, stdout: '', stderr: otherMachine })));
});

test('bare Error (no prefix) with a context block still yields an exception signature', () => {
  // Regression: `throw new Error(...)` head-lines to `Error: msg`. The class
  // regex used to require a prefix, so this fell into the exit-code branch
  // whose normalized first line embeds the `file:line` context — removing
  // dead lines above the throw then shifted it and broke sameFailure.
  const bare = [
    'C:\\Users\\bob\\proj\\repro.js:5',
    "if (data.payload === 'X') throw new Error('E2E_MARK: boom')",
    '                                          ^',
    '',
    'Error: E2E_MARK: boom',
    '    at Object.<anonymous> (C:\\Users\\bob\\proj\\repro.js:5:43)',
  ].join('\n');
  const sig = failureSignature({ code: 1, signal: null, timedOut: false, stdout: '', stderr: bare });
  assert.equal(sig.kind, 'exception');
  assert.equal(sig.normalized, [
    'exception:Error',
    'E2E_MARK: boom',
    'at Object.<anonymous> repro.js',
    'exit:1',
  ].join('\n'));
  // removing dead lines above the throw (context line 5 -> 3) keeps the same failure
  const shifted = bare.replaceAll('repro.js:5', 'repro.js:3');
  assert.ok(sameFailure(sig, failureSignature({ code: 1, signal: null, timedOut: false, stdout: '', stderr: shifted })));
});

test('sameFailure is null-safe', () => {
  const s = failureSignature({ code: 1, signal: null, timedOut: false, stdout: '', stderr: 'x' });
  assert.equal(sameFailure(null, s), false);
  assert.equal(sameFailure(s, null), false);
  assert.equal(sameFailure(null, null), false);
});

test('isScriptFrame distinguishes the repro script from libraries', () => {
  assert.equal(isScriptFrame({ basename: 'repro.js' }, 'repro.js'), true);
  assert.equal(isScriptFrame({ basename: 'lib.js' }, 'repro.js'), false);
});

test('topK bounds how many frames enter the signature', () => {
  const res = {
    code: 1, signal: null, timedOut: false, stdout: '',
    stderr: [
      'BoomError: nope',
      '    at one (/a/one.js:1:1)',
      '    at two (/a/two.js:2:2)',
      '    at three (/a/three.js:3:3)',
      '    at four (/a/four.js:4:4)',
    ].join('\n'),
  };
  const s2 = failureSignature(res, { topK: 2 });
  assert.equal(s2.kind, 'exception');
  assert.ok(s2.normalized.startsWith('exception:BoomError'));
  assert.ok(s2.normalized.includes('at one one.js'));
  assert.ok(s2.normalized.includes('at two two.js'));
  assert.ok(!s2.normalized.includes('three.js'));
});
