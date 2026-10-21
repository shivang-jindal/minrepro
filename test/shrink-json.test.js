import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimizeJson, shrinkNumber, shrinkString, shrinkValue } from '../src/shrink-json.js';

const TRIGGER = 'TRIGGER_VALUE';

/** Bug predicate: fails iff some object anywhere has payload === TRIGGER. */
function hasTrigger(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(hasTrigger);
  for (const [k, val] of Object.entries(v)) {
    if (k === 'payload' && val === TRIGGER) return true;
  }
  return Object.values(v).some(hasTrigger);
}

function noisyInput() {
  return {
    noiseAlpha: 'x'.repeat(120),
    noiseBeta: [1, 2, 3, 4, 5, 6, 7, 8],
    level1: {
      noise: { a: 1, b: { c: [9, 9, 9] } },
      deep: {
        nested: { padding: 'yyyy', keep: false },
        payload: TRIGGER,
      },
    },
    noiseGamma: { z: null, w: true },
    noiseDelta: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
}

test('minimizeJson reaches the EXACT minimum for a trigger amid noise', async () => {
  const probed = [];
  const probe = async (cand) => {
    probed.push(JSON.stringify(cand));
    return { reproduces: hasTrigger(cand) };
  };
  const res = await minimizeJson({ value: noisyInput(), probe, maxProbes: 1000 });
  assert.equal(res.exhausted, false);
  assert.equal(res.exhaustedReason, null);
  assert.deepEqual(res.value, { payload: TRIGGER });
  assert.equal(JSON.stringify(res.value), '{"payload":"TRIGGER_VALUE"}');
  // final minimum still reproduces the bug
  assert.equal(hasTrigger(res.value), true);
});

test('minimizeJson probe results are never duplicated (cache-dedupe observable)', async () => {
  const probed = [];
  const probe = async (cand) => {
    probed.push(JSON.stringify(cand));
    return { reproduces: hasTrigger(cand) };
  };
  const res = await minimizeJson({ value: noisyInput(), probe, maxProbes: 1000 });
  assert.ok(probed.length > 5, `expected a real shrink search, got ${probed.length} probes`);
  assert.equal(new Set(probed).size, probed.length, 'the same candidate must never be probed twice');
  assert.equal(res.probesAccepted + res.probesRejected, probed.length);
});

test('minimizeJson honors maxProbes with an honest partial result', async () => {
  const probed = [];
  const probe = async (cand) => {
    probed.push(JSON.stringify(cand));
    return { reproduces: hasTrigger(cand) };
  };
  const res = await minimizeJson({ value: noisyInput(), probe, maxProbes: 3 });
  assert.equal(res.exhausted, true);
  assert.match(res.exhaustedReason, /probe budget exhausted/);
  assert.ok(probed.length <= 3, `budget must cap probes: ${probed.length}`);
  // honest partial: the returned value still reproduces, next candidates listed
  assert.equal(hasTrigger(res.value), true);
  assert.ok(Array.isArray(res.nextCandidates));
  assert.ok(res.nextCandidates.length > 0);
  assert.ok(res.nextCandidates.every((c) => typeof c === 'string' && c.length <= 200));
});

test('minimizeJson keeps the original when nothing reproduces', async () => {
  const value = { payload: TRIGGER, other: [1, 2, 3] };
  const probe = async () => ({ reproduces: false });
  const res = await minimizeJson({ value, probe });
  assert.deepEqual(res.value, value);
  assert.equal(res.probesAccepted, 0);
  assert.ok(res.probesRejected > 0);
});

test('minimizeJson shrinks numbers toward 0', async () => {
  const probe = async (cand) => ({ reproduces: cand !== null && cand.n === 0 });
  const res = await minimizeJson({ value: { n: 100, noise: 'abc' }, probe });
  assert.deepEqual(res.value, { n: 0 });
});

test('shrinkNumber yields 0, 1, -1 and halved values (never itself)', () => {
  assert.deepEqual([...shrinkNumber(100)], [0, 1, -1, 50]);
  assert.deepEqual([...shrinkNumber(0)], []);
  assert.deepEqual([...shrinkNumber(1)], [0, -1]);
  assert.deepEqual([...shrinkNumber(-1)], [0, 1]);
  assert.deepEqual([...shrinkNumber(0.5)], [0, 1, -1]);
});

test('shrinkString bisects toward empty', () => {
  assert.deepEqual([...shrinkString('abcdef')], ['', 'abc']); // equal halves: one yielded
  assert.deepEqual([...shrinkString('abcde')], ['', 'ab', 'cde']);
  assert.deepEqual([...shrinkString('')], []);
  assert.deepEqual([...shrinkString('a')], ['', 'a']); // second half is the whole string
});

test('shrinkValue unwraps single-element containers and drops chunks/elements', () => {
  assert.deepEqual([...shrinkValue([7])], [7]);
  const arr = [1, 2, 3, 4];
  const arrCands = [...shrinkValue(arr)];
  assert.ok(arrCands.some((c) => JSON.stringify(c) === JSON.stringify([1, 2])));
  assert.ok(arrCands.some((c) => JSON.stringify(c) === JSON.stringify([3, 4])));
  assert.ok(arrCands.some((c) => JSON.stringify(c) === JSON.stringify([2, 3, 4])));

  const obj = { a: 1, b: 2 };
  const objCands = [...shrinkValue(obj)];
  assert.ok(objCands.some((c) => JSON.stringify(c) === JSON.stringify({ b: 2 })));
  assert.ok(objCands.some((c) => JSON.stringify(c) === JSON.stringify({ a: 0, b: 2 }))); // in-place number shrink

  // single-key containers unwrap, but the original also shrinks in place
  const single = [...shrinkValue({ only: 5 })];
  assert.ok(single.some((c) => c === 5)); // unwrap
  assert.ok(single.some((c) => JSON.stringify(c) === '{}')); // delete key
  assert.ok(single.some((c) => JSON.stringify(c) === '{"only":0}')); // shrink value
  assert.deepEqual([...shrinkValue(true)], [false]);
  assert.deepEqual([...shrinkValue(false)], []);
  assert.deepEqual([...shrinkValue(null)], []);
  assert.deepEqual([...shrinkValue('x')], ['', 'x']); // mirrors shrinkString: '' + whole
});
