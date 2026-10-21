import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddminLines } from '../src/ddmin.js';

const REQUIRED = ['line-04', 'line-16', 'line-32'];

function fixture40() {
  return Array.from({ length: 40 }, (_, i) => `line-${String(i).padStart(2, '0')}`).join('\n');
}

const failsOnlyOnRequired = (text) => ({ reproduces: REQUIRED.every((m) => text.includes(m)) });

test('ddmin finds the EXACT minimal line set (3 of 40)', async () => {
  let probes = 0;
  const probe = async (text) => { probes += 1; return failsOnlyOnRequired(text); };
  const res = await ddminLines({ text: fixture40(), probe });
  assert.equal(res.exhausted, false);
  assert.deepEqual(res.keptLines, [4, 16, 32]);
  assert.equal(res.text, 'line-04\nline-16\nline-32');
  assert.ok(probes > 0);
});

test('ddmin accepted count equals the number of lines actually removed', async () => {
  const probe = async (text) => failsOnlyOnRequired(text);
  const res = await ddminLines({ text: fixture40(), probe });
  assert.equal(res.probesAccepted, 37); // 40 lines -> 3 kept
  assert.ok(res.probesRejected > 0);
});

test('ddmin respects maxProbes and reports an honest partial result', async () => {
  let probes = 0;
  const probe = async (text) => { probes += 1; return failsOnlyOnRequired(text); };
  const res = await ddminLines({ text: fixture40(), probe, maxProbes: 3 });
  assert.equal(res.exhausted, true);
  assert.match(res.exhaustedReason, /probe budget exhausted/);
  assert.ok(probes <= 3, `budget must cap probes: ${probes}`);
  // honest partial: kept text is still a subset of the original lines
  const original = new Set(fixture40().split('\n'));
  for (const l of res.text.split('\n')) assert.ok(original.has(l));
  // next-best candidates listed per SPEC §9
  assert.ok(res.nextCandidates.length > 0);
  assert.ok(res.nextCandidates.every((c) => /^remove line \d+: /.test(c)));
});

test('ddmin never removes protected lines', async () => {
  const probe = async (text) => failsOnlyOnRequired(text);
  const res = await ddminLines({ text: fixture40(), probe, protect: [0] });
  assert.deepEqual(res.keptLines, [0, 4, 16, 32]);
  assert.ok(res.text.includes('line-00'));
});

test('ddmin normalizes CRLF input to LF output', async () => {
  const text = 'TXT_A\r\nnoise\r\nTXT_B\r\nTXT_C';
  const probe = async (t) => ({ reproduces: ['TXT_A', 'TXT_B', 'TXT_C'].every((m) => t.includes(m)) });
  const res = await ddminLines({ text, probe });
  assert.deepEqual(res.keptLines, [0, 2, 3]);
  assert.equal(res.text, 'TXT_A\nTXT_B\nTXT_C');
});

test('ddmin terminates on a single-line input that must be kept', async () => {
  let probes = 0;
  const probe = async (t) => { probes += 1; return { reproduces: t.includes('only') }; };
  const res = await ddminLines({ text: 'only', probe });
  assert.deepEqual(res.keptLines, [0]);
  assert.equal(res.text, 'only');
  assert.equal(res.exhausted, false);
  assert.ok(probes <= 2);
});
