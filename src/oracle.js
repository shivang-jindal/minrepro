// oracle.js — the sacred oracle (SPEC §1.1, §4 stage 2/3).
// A probe writes a candidate into a fresh temp dir, runs the repro command
// against it (path via argv or MINREPRO_INPUT env), captures the outcome,
// and checks the normalized failure signature. Determinism harness: probe
// N=10 up front; 10/10 => confident, 3..9/10 => flaky mode (badge it),
// <3/10 => could-not-reproduce. Never auto-retry into green.
import { writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { exec as realExec, cleanEnv, scratchDir } from './exec.js';
import { failureSignature, sameFailure } from './signature.js';
import { moduleTypeFor, mirrorModuleType } from './module-type.js';
import { hash } from './util.js';

// Determinism stabilization baked into every probe env (SPEC §5.3 partial:
// clock/RNG pinning is v1; TZ/locale/thread pins are free and help).
export const STABLE_ENV = { TZ: 'UTC', LANG: 'C', LC_ALL: 'C', OMP_NUM_THREADS: '1' };

const SHELL = process.platform === 'win32'
  ? { file: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c'] }
  : { file: '/bin/sh', prefix: ['-c'] };

export class Oracle {
  /**
   * @param {object} o
   * @param {string} o.repro         repro script path or shell command template
   * @param {string} o.inputText     original candidate input (JSON or text)
   * @param {string} [o.inputName]   original input file name (drives extension)
   * @param {Function} [o.exec]      injected exec runner
   * @param {number} [o.timeoutMs]   per-probe timeout
   * @param {number} [o.maxProbes]   budget cap for minimize-stage probes
   * @param {object} [o.log]         logger
   */
  constructor({ repro, inputText, inputName = 'input.json', exec = realExec, timeoutMs = 10000, maxProbes = 300, log }) {
    this.repro = repro;
    this.inputText = inputText;
    this.inputExt = /\.[A-Za-z0-9]+$/.test(inputName) ? inputName.slice(inputName.lastIndexOf('.')) : '.txt';
    this.scriptBasename = this.#scriptBasename(repro);
    // when repro points at a script file, remember its module type so
    // candidate copies in scratch dirs execute identically (ESM vs CJS)
    this.moduleType = /\.(js|mjs|cjs)$/i.test(repro) && !repro.includes('{input}')
      ? moduleTypeFor(isAbsolute(repro) ? repro : resolve(repro))
      : 'commonjs';
    this.exec = exec;
    this.timeoutMs = timeoutMs;
    this.maxProbes = maxProbes;
    this.log = log;
    this.signature = null;       // set by calibrate()
    this.confidence = 0;         // matched/total from calibration
    this.calibration = null;     // {total, matched, flaky}
    this.cache = new Map();      // hash -> {reproduces, signature}
    this.stats = { probes: 0, cacheHits: 0, cacheMisses: 0, cacheSaves: 0 };
    this.timings = [];
    // env vars that every probe sees on top of the allowlist (set when the
    // bug is env-gated and calibration needed the launch environment)
    this.baseEnv = {};
  }

  #scriptBasename(repro) {
    // Only meaningful when repro points at a file; shell templates get the
    // input-name-derived default so signature frames still normalize.
    if (/\.(js|mjs|cjs)$/i.test(repro) && !repro.includes('{input}')) return basename(repro);
    return 'repro-script';
  }

  /** How the repro is launched for a given probe dir. */
  #command(inputPath) {
    const r = this.repro;
    const looksLikeScript = /\.(js|mjs|cjs)$/i.test(r) && !r.includes('{input}');
    if (looksLikeScript) {
      const script = isAbsolute(r) ? r : resolve(r);
      return { file: process.execPath, args: [script, inputPath] };
    }
    // shell command template: {input} placeholder or appended path
    const cmd = r.includes('{input}') ? r.replaceAll('{input}', `"${inputPath}"`) : `${r} "${inputPath}"`;
    return { file: SHELL.file, args: [...SHELL.prefix, cmd] };
  }

  /**
   * Execute one probe. Always real (never cached) — used by the determinism
   * harness and by probeCandidate on cache miss.
   * @param {{inputText?:string, scriptText?:string, env?:object}} variant
   *        scriptText: when set, write this as the repro script (code-min stage)
   *        env: extra env vars on top of allowlist + stable pins
   */
  async runOnce(variant = {}) {
    const inputText = variant.inputText ?? this.inputText;
    const env = { ...STABLE_ENV, ...this.baseEnv, ...(variant.env || {}) };
    const scratch = scratchDir('minrepro-probe-');
    try {
      const inputPath = join(scratch.dir, `input${this.inputExt}`);
      writeFileSync(inputPath, inputText, 'utf8');
      let cmd;
      if (variant.scriptText !== undefined) {
        // code-minimization: run a candidate copy of the script, same basename
        const scriptPath = join(scratch.dir, this.scriptBasename);
        writeFileSync(scriptPath, variant.scriptText, 'utf8');
        if (this.moduleType === 'module') mirrorModuleType(scratch.dir, 'module');
        cmd = { file: process.execPath, args: [scriptPath, inputPath] };
      } else {
        cmd = this.#command(inputPath);
      }
      this.stats.probes += 1;
      const result = await this.exec(cmd.file, cmd.args, {
        cwd: scratch.dir,
        env: cleanEnv(env),
        timeoutMs: this.timeoutMs,
      });
      this.timings.push(result.durationMs ?? 0);
      return { result, signature: failureSignature(result, { scriptBasename: this.scriptBasename }) };
    } finally {
      scratch.cleanup();
    }
  }

  /**
   * Probe a candidate, with caching keyed by candidate hash (SPEC §6.1).
   * The cache is the single biggest performance lever; same candidate is
   * never executed twice within a stage-context.
   * @param {{fresh?:boolean}} [opts] fresh:true bypasses the cache — the
   *        final verification stage must execute the artifact N real times
   *        (SPEC §8); a cached verdict would turn "verify ×N" into a lie
   *        for nondeterministic (flaky) oracles.
   */
  async probeCandidate(inputText, extra = {}, { fresh = false } = {}) {
    const key = hash(inputText, extra.scriptText ?? '', JSON.stringify(extra.env ?? {}), JSON.stringify(this.baseEnv));
    if (!fresh && this.cache.has(key)) {
      this.stats.cacheHits += 1;
      const hit = this.cache.get(key);
      return { ...hit, cached: true };
    }
    this.stats.cacheMisses += 1;
    const { result, signature } = await this.runOnce({ inputText, ...extra });
    const entry = {
      reproduces: sameFailure(signature, this.signature),
      signature,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
    this.cache.set(key, entry);
    return { ...entry, cached: false };
  }

  /**
   * Determinism harness (SPEC §5): probe the original N times.
   * Reference signature = most common *failure* signature (passes never
   * become the oracle). 10/10 => deterministic; 3..9/10 => flaky mode;
   * <3/10 or zero failures => could-not-reproduce. Never retry into green.
   * @returns {{ok:boolean, total:number, matched:number, flaky:boolean,
   *            confidence:number, mode:'deterministic'|'flaky'|'none'}}
   */
  async calibrate(n = 10, extraEnv = {}) {
    const sigs = [];
    const failed = [];
    for (let i = 0; i < n; i++) {
      const { result, signature } = await this.runOnce({ env: extraEnv });
      const isFail = result.timedOut || result.signal !== null || (result.code ?? 0) !== 0;
      sigs.push(signature);
      failed.push(isFail ? signature : null);
    }
    // pick most common failure signature as the reference
    const counts = new Map();
    for (const s of failed) {
      if (!s) continue;
      counts.set(s.normalized, { sig: s, n: (counts.get(s.normalized)?.n ?? 0) + 1 });
    }
    let reference = null;
    let best = 0;
    for (const { sig, n: c } of counts.values()) {
      if (c > best) { best = c; reference = sig; }
    }
    const matched = reference ? sigs.filter((s) => sameFailure(s, reference)).length : 0;
    this.signature = reference;
    this.calibration = { total: n, matched, outcomes: sigs.map((s) => !!reference && sameFailure(s, reference)) };
    this.confidence = n ? matched / n : 0;
    if (!reference || matched === 0) {
      return { ok: false, total: n, matched, flaky: false, confidence: this.confidence, mode: 'none' };
    }
    if (matched >= n) {
      return { ok: true, total: n, matched, flaky: false, confidence: 1, mode: 'deterministic' };
    }
    if (matched >= 3) {
      // flaky mode: keep going, but badge everything downstream
      return { ok: true, total: n, matched, flaky: true, confidence: matched / n, mode: 'flaky' };
    }
    return { ok: false, total: n, matched, flaky: false, confidence: matched / n, mode: 'none' };
  }
}
