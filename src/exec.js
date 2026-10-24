// exec.js — process execution with sandbox-lite guarantees:
// fresh temp cwd, clean env allowlist, timeout with tree-kill.
// Every consumer takes `exec` by injection so tests can fake it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

// Env vars required for a spawned Node process to work at all.
// Everything else from the parent environment is stripped unless the
// caller explicitly passes extra vars (env-minimization stage).
export const ENV_ALLOWLIST = [
  'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS',
];

export function cleanEnv(extra = {}) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // de-dup on Windows case-insensitive keys
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  return env;
}

/**
 * Kill a child and (best-effort) its whole process tree.
 * Windows: taskkill /T /F. POSIX: SIGKILL to the process group.
 */
export function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* already dead */
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/**
 * The real exec runner.
 * @param {string} file  executable (e.g. process.execPath) or command
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, timeoutMs?:number, input?:string}} opts
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number}>}
 */
export function exec(file, args, opts = {}) {
  const { cwd, env, timeoutMs = 10000, input } = opts;
  return new Promise((resolve) => {
    const started = Date.now();
    // cmd.exe is a shell: it parses its own /c tail as a command line.
    // libuv's default argument quoting would escape embedded quotes
    // (`"path"` -> `\"path\"`), which cmd passes through literally and the
    // child then treats as part of the filename — so hand it over verbatim.
    const isWinShell = process.platform === 'win32' && /(?:^|[\\/])(?:cmd|command)(?:\.exe)?$/i.test(file);
    const child = spawn(file, args, {
      cwd,
      env: env ?? cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: isWinShell,
      detached: process.platform !== 'win32',
    });
    // Chunks are buffered as raw bytes and decoded ONCE at close: per-chunk
    // `String(d)` decodes multibyte UTF-8 sequences that straddle a pipe chunk
    // boundary into U+FFFD — at OS-scheduling-dependent split points, which
    // would make failure signatures nondeterministic across runs.
    const chunks = { stdout: [], stderr: [] };
    let outBytes = 0; let errBytes = 0;
    let timedOut = false;
    const MAX_OUT = 512 * 1024;
    child.stdout.on('data', (d) => {
      if (outBytes < MAX_OUT) { chunks.stdout.push(d); outBytes += d.length; }
    });
    child.stderr.on('data', (d) => {
      if (errBytes < MAX_OUT) { chunks.stderr.push(d); errBytes += d.length; }
    });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: bufText(chunks.stdout), stderr: bufText(chunks.stderr) + String(err && err.message), timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: bufText(chunks.stdout), stderr: bufText(chunks.stderr), timedOut, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Decode accumulated byte chunks (capped) as ONE utf8 string. */
function bufText(chunks) {
  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}

/** Create a scratch dir under the OS temp dir; returns {dir, cleanup}. */
export function scratchDir(prefix = 'minrepro-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
