import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../src/budget.js';

test('trySpend spends up to maxProbes then refuses', () => {
  const b = new Budget(3);
  assert.equal(b.remaining, 3);
  assert.equal(b.trySpend(), true);
  assert.equal(b.trySpend(), true);
  assert.equal(b.trySpend(), true);
  assert.equal(b.trySpend(), false);
  assert.equal(b.exhausted, true);
  assert.match(b.exhaustedReason, /probe budget exhausted \(3\)/);
  assert.equal(b.probes, 3);
  assert.equal(b.remaining, 0);
});

test('cache hits are free; only real probes cost budget', () => {
  const b = new Budget(2);
  b.charge(false); // real probe 1
  b.charge(true);  // cache hit
  b.charge(true);  // cache hit
  assert.equal(b.probes, 1);
  assert.equal(b.cacheHits, 2);
  assert.equal(b.exhausted, false);
  b.charge(false); // real probe 2 -> budget hit
  assert.equal(b.exhausted, true);
  assert.match(b.exhaustedReason, /probe budget exhausted \(2\)/);
});

test('exhausted getter derives the reason lazily from probe count', () => {
  const b = new Budget(1);
  assert.equal(b.exhausted, false);
  b.charge(false);
  assert.equal(b.exhausted, true);
  assert.match(b.exhaustedReason, /probe budget exhausted/);
});

test('wall-clock budget also exhausts', () => {
  const b = new Budget(1000000, 1); // 1 ms cap
  let spins = 0;
  while (b.trySpend() && spins < 10000000) spins += 1;
  assert.equal(b.exhausted, true);
  assert.match(b.exhaustedReason, /wall-clock budget exhausted/);
  assert.ok(spins < 10000000, 'must stop spinning');
});

test('maxMs=0 means no wall-clock cap', () => {
  const b = new Budget(5, 0);
  for (let i = 0; i < 5; i++) assert.equal(b.trySpend(), true);
  assert.equal(b.exhausted, true);
  assert.match(b.exhaustedReason, /probe budget/);
});
