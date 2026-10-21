import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteSize, hash, humanBytes, joinLines, makeLogger, splitLines } from '../src/util.js';

test('hash is deterministic per input and differs across parts', () => {
  assert.equal(hash('a', 'b'), hash('a', 'b'));
  assert.notEqual(hash('a', 'b'), hash('ab')); // NUL-separated parts
  assert.notEqual(hash('a'), hash({ a: 1 }));
  assert.notEqual(hash('a'), hash('b'));
  assert.equal(hash({ a: 1 }).length, 64); // sha256 hex
});

test('byteSize counts UTF-8 bytes, not code units', () => {
  assert.equal(byteSize('abc'), 3);
  assert.equal(byteSize('héllo'), 6);
  assert.equal(byteSize('💥'), 4);
});

test('humanBytes formats B / KB / MB', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(842), '842 B');
  assert.equal(humanBytes(1023), '1023 B');
  assert.equal(humanBytes(12428), '12.1 KB');
  assert.equal(humanBytes(2 * 1024 * 1024), '2.00 MB');
});

test('splitLines/joinLines normalize CRLF round-trips', () => {
  assert.deepEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
  assert.equal(joinLines(['a', 'b', 'c']), 'a\nb\nc');
  assert.deepEqual(splitLines(''), ['']);
});

test('makeLogger respects quiet and routes to the sink', () => {
  const lines = [];
  const loud = makeLogger((s) => lines.push(s), false);
  loud.info('progress');
  loud.always('summary');
  assert.deepEqual(lines, ['progress', 'summary']);

  const quietLines = [];
  const quiet = makeLogger((s) => quietLines.push(s), true);
  quiet.info('hidden');
  quiet.always('shown');
  assert.deepEqual(quietLines, ['shown']);
});
