import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowlisted, captureRemovable, minimizeEnv, probeEnv } from '../src/env-min.js';

/** 15 removable vars; the bug is gated on VAR_7 alone. */
function gateVars(gateName = 'VAR_7', gateValue = 'yes') {
  return Array.from({ length: 15 }, (_, i) => ({
    name: `VAR_${i}`,
    value: i === 7 ? gateValue : `noise-${i}`,
  }));
}

test('allowlisted names match case-insensitively', () => {
  for (const n of ['PATH', 'path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'HOME', 'LANG', 'NODE_OPTIONS']) {
    assert.equal(allowlisted(n), true, n);
  }
  for (const n of ['FOO', 'MY_SECRET', 'VAR_7', 'PATHEXT_EXTRA']) {
    assert.equal(allowlisted(n), false, n);
  }
});

test('captureRemovable drops allowlisted and multi-line vars', () => {
  const captured = captureRemovable({
    PATH: 'C:\\x',
    SystemRoot: 'C:\\Windows',
    BUG_GATE: '1',
    EMPTY: '',
    MULTILINE: 'a\nb',
  });
  assert.deepEqual(captured.map((v) => v.name), ['BUG_GATE', 'EMPTY']);
  assert.equal(captured[0].value, '1');
});

test('minimizeEnv isolates the ONE gating env var among 15', async () => {
  let probes = 0;
  const seenEnvs = [];
  const probe = async (env) => {
    probes += 1;
    seenEnvs.push(env);
    return { reproduces: env.VAR_7 === 'yes' };
  };
  const res = await minimizeEnv({ vars: gateVars(), probe });
  assert.equal(res.exhausted, false);
  assert.deepEqual(res.keptNames, ['VAR_7']);
  assert.deepEqual(res.kept, { VAR_7: 'yes' });
  assert.ok(probes > 0);
  // candidates are subsets of the original vars
  for (const env of seenEnvs) {
    for (const k of Object.keys(env)) assert.match(k, /^VAR_\d+$/);
  }
});

test('minimizeEnv gate on a differently named var works too', async () => {
  const probe = async (env) => ({ reproduces: env.GATE_VAR === 'on' });
  const vars = [
    ...Array.from({ length: 10 }, (_, i) => ({ name: `NOISE_${i}`, value: `n${i}` })),
    { name: 'GATE_VAR', value: 'on' },
  ];
  const res = await minimizeEnv({ vars, probe });
  assert.deepEqual(res.keptNames, ['GATE_VAR']);
});

test('minimizeEnv reports an honest partial result on budget exhaustion', async () => {
  let probes = 0;
  const probe = async (env) => { probes += 1; return { reproduces: env.VAR_7 === 'yes' }; };
  const res = await minimizeEnv({ vars: gateVars(), probe, maxProbes: 2 });
  assert.equal(res.exhausted, true);
  assert.match(res.exhaustedReason, /probe budget exhausted/);
  assert.ok(probes <= 2);
  assert.ok(res.nextCandidates.length > 0);
  // honest partial: whatever is kept still reproduces (the gate survives)
  assert.ok(res.keptNames.includes('VAR_7'));
  assert.ok(res.keptNames.length >= 1 && res.keptNames.length <= 15);
  assert.equal(res.kept.VAR_7, 'yes');
});

test('probeEnv builds allowlist + extras and drops host-only vars like APPDATA', () => {
  const env = probeEnv({ EXTRA_ONE: 'x' });
  assert.equal(env.EXTRA_ONE, 'x');
  assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0);
  // APPDATA is set on this Windows host but is NOT allowlisted
  assert.ok(!('APPDATA' in env));
  assert.ok(!('MINREPRO_TEST_SECRET' in env));
});
