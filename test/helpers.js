// Shared helpers for the minrepro test suite (not a test file itself).
// Everything runs with zero dependencies: node:test + node:assert only.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the minrepro package root. */
export const BASE = fileURLToPath(new URL('..', import.meta.url));

/** Create a scratch dir under os.tmpdir(); returns {dir, cleanup}. */
export function tempDir(prefix = 'minrepro-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Write content into dir (creating parents) and return the full path. */
export function write(dir, name, content) {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Spawn an arbitrary executable; resolves {code, signal, stdout, stderr}. */
export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      resolve({ code: null, signal: null, stdout, stderr: stderr + String(err?.message ?? err) });
    });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Spawn the current Node binary. */
export function runNode(args, opts = {}) {
  return run(process.execPath, args, opts);
}

/** Noisy JSON text: a junk key beside a nested payload, pretty-printed.
 *  (Deliberately small: pipeline tests probe it with real child processes,
 *  so every extra key costs real probe runs.) */
export function noisyJson(triggerValue = 'TRIGGER_VALUE') {
  return JSON.stringify({
    junk: 'xx',
    level1: { payload: triggerValue },
  }, null, 2);
}

/** Repro script for the noisy JSON fixture: fails iff level1.payload matches.
 *  5 lines with two dead ones; the throw (line 5) is the only stack frame
 *  and must survive code minimization. */
export const E2E_SCRIPT = `const raw = require('node:fs').readFileSync(process.argv[2], 'utf8');
const data = JSON.parse(raw);
const dead1 = 'noise-one';
const dead2 = 42;
if (data.level1.payload === 'TRIGGER_VALUE') throw new Error('E2E_MARK: trigger payload exploded');
`;
