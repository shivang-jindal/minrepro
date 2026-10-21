import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mirrorModuleType, moduleTypeFor } from '../src/module-type.js';
import { tempDir, write } from './helpers.js';

test('moduleTypeFor finds an ancestor package.json declaring type=module', () => {
  const scratch = tempDir('minrepro-mt-');
  try {
    write(scratch.dir, 'package.json', JSON.stringify({ type: 'module' }));
    const deep = join(scratch.dir, 'a', 'b');
    assert.equal(moduleTypeFor(join(deep, 'script.js')), 'module');
  } finally {
    scratch.cleanup();
  }
});

test('moduleTypeFor reports commonjs for type=commonjs', () => {
  const scratch = tempDir('minrepro-mt-');
  try {
    write(scratch.dir, 'package.json', JSON.stringify({ type: 'commonjs' }));
    assert.equal(moduleTypeFor(join(scratch.dir, 'script.js')), 'commonjs');
  } finally {
    scratch.cleanup();
  }
});

test('moduleTypeFor falls back to commonjs on a malformed package.json', () => {
  const scratch = tempDir('minrepro-mt-');
  try {
    write(scratch.dir, 'package.json', '{ not json !!!');
    assert.equal(moduleTypeFor(join(scratch.dir, 'script.js')), 'commonjs');
  } finally {
    scratch.cleanup();
  }
});

test('moduleTypeFor returns commonjs when no package.json declares a type', () => {
  // No package.json is written in the temp chain; any ancestor package.json
  // on this host has no "type" field, so the documented fallback is commonjs.
  const scratch = tempDir('minrepro-mt-');
  try {
    assert.equal(moduleTypeFor(join(scratch.dir, 'script.js')), 'commonjs');
  } finally {
    scratch.cleanup();
  }
});

test('mirrorModuleType writes a package.json declaring the type', () => {
  const scratch = tempDir('minrepro-mt-');
  try {
    mirrorModuleType(scratch.dir, 'module');
    const pkg = JSON.parse(readFileSync(join(scratch.dir, 'package.json'), 'utf8'));
    assert.deepEqual(pkg, { type: 'module' });
    assert.equal(moduleTypeFor(join(scratch.dir, 'script.js')), 'module');
    mirrorModuleType(scratch.dir, 'commonjs');
    assert.equal(moduleTypeFor(join(scratch.dir, 'script.js')), 'commonjs');
    assert.ok(existsSync(join(scratch.dir, 'package.json')));
  } finally {
    scratch.cleanup();
  }
});
