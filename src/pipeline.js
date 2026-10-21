// pipeline.js — orchestration for `minrepro run` (SPEC §4 stages 3–8,
// self-contained mode). Calibrate → minimize input → minimize code →
// minimize env → final verify ×N → write artifacts. Every stage is
// bounded, logs accept/reject, and reports honest partial results.
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Oracle, STABLE_ENV } from './oracle.js';
import { minimizeJson } from './shrink-json.js';
import { ddminLines } from './ddmin.js';
import { minimizeCode, stackLines, syntaxOk } from './code-min.js';
import { minimizeEnv, captureRemovable } from './env-min.js';
import { failureSignature } from './signature.js';
import { writeArtifacts } from './artifacts.js';
import { humanBytes, makeLogger } from './util.js';
import { exec as realExec } from './exec.js';

/**
 * Run the full pipeline.
 * @param {object} o
 * @param {string} o.repro          repro script path or command template
 * @param {string} o.input          path to the original failing input
 * @param {string[]} [o.stages]     subset of ['input','code','env']
 * @param {number} [o.maxProbes]
 * @param {number} [o.calibrationRuns]
 * @param {number} [o.timeoutMs]
 * @param {string} [o.outDir]
 * @param {string} [o.title]
 * @param {Function} [o.exec]
 * @param {object} [o.env]          launch env to capture removable vars from
 * @param {(msg:string)=>void} [o.sink]
 * @param {boolean} [o.quiet]
 * @returns {Promise<{exitCode:number, state:object, outDir:string}>}
 */
export async function runPipeline(o) {
  const exec = o.exec ?? realExec;
  const log = makeLogger(o.sink, o.quiet);
  const stages = o.stages ?? ['input', 'code', 'env'];
  const maxProbes = o.maxProbes ?? 300;
  const calibrationRuns = o.calibrationRuns ?? 10;
  const timeoutMs = o.timeoutMs ?? 10000;
  const outDir = o.outDir ?? 'repro';
  const envSource = o.env ?? process.env;

  const inputPath = isAbsolute(o.input) ? o.input : resolve(o.input);
  const inputText = readFileSync(inputPath, 'utf8');
  const inputExt = /\.[A-Za-z0-9]+$/.test(o.input) ? o.input.slice(o.input.lastIndexOf('.')) : '.txt';
  const repro = /\.(js|mjs|cjs)$/.test(o.repro) && !o.repro.includes('{input}')
    ? (isAbsolute(o.repro) ? o.repro : resolve(o.repro))
    : o.repro;

  const stageLog = [];
  const budgetNotes = [];
  const logStage = (s) => { stageLog.push(s); log.info(s); };

  const oracle = new Oracle({
    repro, inputText, inputName: o.input, exec, timeoutMs, maxProbes, log,
  });

  // captured launch environment (candidates for the env-minimization stage)
  const removable = captureRemovable(envSource);

  // ---- stage 3: determinism harness ------------------------------------
  // Always calibrate with the clean allowlist env first (sandbox-lite: the
  // probe never sees the reporter's secrets). Only if that cannot reproduce
  // do we fall back to the full captured launch env (env-gated bugs), and
  // then stage 6 shrinks it back down.
  logStage(`[calibrate] probing original ${calibrationRuns}× (clean env) ...`);
  let cal = await oracle.calibrate(calibrationRuns);
  let envMode = 'clean';
  if (!cal.ok && removable.length > 0) {
    const launchEnv = {};
    for (const v of removable) launchEnv[v.name] = v.value;
    logStage(`[calibrate] clean env did not reproduce; retrying with launch env (${removable.length} vars) ...`);
    const cal2 = await oracle.calibrate(calibrationRuns, launchEnv);
    if (cal2.ok) {
      oracle.baseEnv = launchEnv;
      cal = cal2;
      envMode = 'launch';
      logStage('[calibrate] reproduced with launch environment — bug appears env-gated');
    }
  }
  logStage(`[calibrate] ${cal.matched}/${cal.total} reproduced · mode=${cal.mode} · env=${envMode}`);
  if (!cal.ok) {
    const state = exitState({
      title: o.title ?? o.repro, exitCode: 3, calibration: cal, signature: null,
      stages: {}, stageLog, budgetNotes,
      note: `could not reproduce: only ${cal.matched}/${cal.total} probes matched a failure signature (need ≥3/10)`,
    });
    logStage(`[exit] ${state.note}`);
    const written = writeArtifacts({ outDir, state, inputExt });
    log.always(`Artifacts written to ${written.dir}/ (report.md explains the failure)`);
    return { exitCode: 3, state, outDir };
  }
  const signature = oracle.signature;
  const flaky = cal.flaky;
  if (flaky) {
    budgetNotes.push(`FLAKY ORACLE: failure reproduced ${cal.matched}/${cal.total} runs; `
      + 'all minimization below is best-effort against a nondeterministic predicate');
  }

  const stageResults = {};
  const inputStagesEnabled = stages.includes('input');
  const codeStageEnabled = stages.includes('code');
  const envStageEnabled = stages.includes('env');

  let currentInput = inputText;
  let currentScript = null;      // set by code stage / for verify
  let currentExtraEnv = {};      // narrowed by env stage
  let currentValue = undefined;  // parsed JSON when applicable

  // ---- stage 4: minimize input -----------------------------------------
  const isJson = detectJson(inputText);
  if (inputStagesEnabled) {
    const probe = async (candidate) => {
      const r = await oracle.probeCandidate(typeof candidate === 'string' ? candidate : JSON.stringify(candidate));
      return r;
    };
    if (isJson) {
      logStage('[input] structured JSON shrinking ...');
      currentValue = JSON.parse(inputText);
      const res = await minimizeJson({ value: currentValue, probe, maxProbes, log });
      currentInput = JSON.stringify(res.value);
      currentValue = res.value;
      stageResults.input = {
        strategy: 'json-shrink',
        before: { bytes: byteLen(inputText), chars: inputText.length },
        after: { bytes: byteLen(currentInput), chars: currentInput.length },
        probes: res.probesAccepted + res.probesRejected,
        accepted: res.probesAccepted,
        exhausted: res.exhausted,
        exhaustedReason: res.exhaustedReason,
        nextCandidates: res.nextCandidates,
      };
      if (res.exhausted) {
        budgetNotes.push(`input stage: budget exhausted (${res.exhaustedReason}); `
          + `${res.nextCandidates.length} next candidate(s) listed in repro.json`);
      }
    } else {
      logStage('[input] ddmin (line granularity) ...');
      const res = await ddminLines({ text: inputText, probe, maxProbes, log });
      currentInput = res.text;
      stageResults.input = {
        strategy: 'ddmin-lines',
        before: { bytes: byteLen(inputText), chars: inputText.length },
        after: { bytes: byteLen(currentInput), chars: currentInput.length },
        probes: res.probesAccepted + res.probesRejected,
        accepted: res.probesAccepted,
        exhausted: res.exhausted,
        exhaustedReason: res.exhaustedReason,
        nextCandidates: res.nextCandidates,
      };
      if (res.exhausted) {
        budgetNotes.push(`input stage: budget exhausted (${res.exhaustedReason}); `
          + `${res.nextCandidates.length} next candidate(s) listed in repro.json`);
      }
    }
    logStage(`[input] ${inputText.length} -> ${currentInput.length} chars`);
  } else {
    try { currentValue = JSON.parse(currentInput); } catch { currentValue = undefined; }
  }

  // ---- stage 5: minimize code ------------------------------------------
  const scriptInfo = classifyRepro(repro);
  let minimizedScript = null;
  if (codeStageEnabled && scriptInfo.kind === 'script') {
    const scriptText = readFileSync(scriptInfo.path, 'utf8');
    const ok = await syntaxOk(scriptText, { exec });
    if (!ok) {
      logStage('[code] repro script failed `node --check`; skipping code minimization');
      budgetNotes.push('code stage skipped: repro script is not syntactically valid on its own');
    } else {
      // re-probe original to get a fresh stack with current input
      const base = await oracle.runOnce({ inputText: currentInput });
      const failureOutput = (base.result.stderr || '') + '\n' + (base.result.stdout || '');
      const protected1 = stackLines(scriptText, failureOutput, scriptInfo.basename);
      logStage(`[code] line-based ddmin over repro script (${scriptText.split(/\r?\n/).length} lines) ...`);
      const res = await minimizeCode({
        scriptText,
        scriptBasename: scriptInfo.basename,
        initialStackLines: protected1,
        maxProbes: o.codeMaxProbes ?? 400,
        exec,
        log,
        probe: async (candidateText) => {
          const r = await oracle.probeCandidate(currentInput, { scriptText: candidateText });
          return r;
        },
      });
      minimizedScript = res.text;
      currentScript = res.text;
      stageResults.code = {
        before: { lines: scriptText.split(/\r?\n/).length },
        after: { lines: res.text.split(/\r?\n/).length },
        probes: res.probesAccepted + res.probesRejected,
        accepted: res.probesAccepted,
        syntaxRejected: res.syntaxRejected,
        protectedLines: res.protectedLines,
        exhausted: res.exhausted,
        exhaustedReason: res.exhaustedReason,
        nextCandidates: res.nextCandidates,
      };
      if (res.exhausted) {
        budgetNotes.push(`code stage: budget exhausted (${res.exhaustedReason}); `
          + `${res.nextCandidates.length} next candidate(s) listed in repro.json`);
      }
      logStage(`[code] ${scriptText.split(/\r?\n/).length} -> ${res.text.split(/\r?\n/).length} lines`);
    }
  } else if (codeStageEnabled) {
    logStage('[code] repro is a shell command, not a script — skipping code minimization');
    budgetNotes.push('code stage skipped: --repro is a shell command; v0 only minimizes script repros');
  }

  // ---- stage 6: minimize env -------------------------------------------
  if (envStageEnabled && removable.length > 0) {
    logStage(`[env] delta-debugging ${removable.length} removable env var(s) ...`);
    // During this stage probes must see ONLY allowlist + candidate subset,
    // so clear any baseEnv captured at calibration — otherwise removals in
    // the candidate would silently persist through baseEnv.
    oracle.baseEnv = {};
    const res = await minimizeEnv({
      vars: removable,
      maxProbes: o.envMaxProbes ?? 150,
      log,
      probe: async (extraEnv) => {
        // probe with the narrowed input + narrowed script under candidate env
        const r = await oracle.probeCandidate(currentInput, {
          scriptText: currentScript ?? undefined,
          env: extraEnv,
        });
        return r;
      },
    });
    currentExtraEnv = res.kept;
    stageResults.env = {
      before: { count: removable.length },
      after: { count: res.keptNames.length, names: res.keptNames },
      probes: res.probesAccepted + res.probesRejected,
      exhausted: res.exhausted,
      exhaustedReason: res.exhaustedReason,
      nextCandidates: res.nextCandidates,
    };
    if (res.exhausted) {
      budgetNotes.push(`env stage: budget exhausted (${res.exhaustedReason}); `
        + `${res.nextCandidates.length} next candidate(s) listed in repro.json`);
    }
    logStage(`[env] ${removable.length} -> ${res.keptNames.length} removable var(s) kept: ${res.keptNames.join(', ') || 'none'}`);
  } else {
    stageResults.env = { before: { count: removable.length }, after: { count: removable.length, names: removable.map((v) => v.name) }, probes: 0, skipped: true };
  }

  // ---- stage 8: final verify ×N ----------------------------------------
  // Fresh runs (no cache): this stage's whole point is to execute the final
  // artifact N times — a cached verdict would not measure reproducibility.
  const verifyRuns = o.verifyRuns ?? 10;
  let matched = 0;
  for (let i = 0; i < verifyRuns; i++) {
    const r = await oracle.probeCandidate(currentInput, {
      scriptText: currentScript ?? undefined,
      env: currentExtraEnv,
    }, { fresh: true });
    if (r.reproduces) matched += 1;
  }
  const finalVerify = { total: verifyRuns, matched };
  logStage(`[verify] final artifact reproduced ${matched}/${verifyRuns} runs`);

  const anyExhausted = Object.values(stageResults).some((s) => s.exhausted);
  let exitCode = 0;
  if (matched === 0) exitCode = 3;
  else if (matched < verifyRuns || flaky || anyExhausted) exitCode = 1;

  const state = {
    title: o.title ?? o.repro,
    exitCode,
    calibration: { total: cal.total, matched: cal.matched, flaky: cal.flaky, mode: cal.mode, confidence: cal.confidence },
    signature,
    stages: stageResults,
    minimizedInput: currentInput,
    minimizedScript: minimizedScript ?? (scriptInfo.kind === 'script' ? readFileSync(scriptInfo.path, 'utf8') : undefined),
    finalVerify,
    stageLog,
    budgetNotes,
    probeStats: { ...oracle.stats, calibrationProbes: cal.total },
    budgets: {
      maxProbes,
      codeMaxProbes: o.codeMaxProbes ?? 400,
      envMaxProbes: o.envMaxProbes ?? 150,
      probesUsedByOracle: oracle.stats.probes,
    },
    extraEnv: currentExtraEnv,
  };
  const written = writeArtifacts({ outDir, state, inputExt });
  log.always(`minrepro: ${humanBytes(byteLen(inputText))} input -> ${humanBytes(byteLen(currentInput))}; `
    + `calibration ${cal.matched}/${cal.total}${flaky ? ' (FLAKY)' : ''}; final verify ${matched}/${verifyRuns}`);
  log.always(`Artifacts: ${written.dir}/report.md, repro.json, run.sh, run.cmd`);
  return { exitCode, state, outDir };
}

function exitState(base) {
  return {
    title: base.title, exitCode: base.exitCode, calibration: base.calibration,
    signature: base.signature, stages: base.stages, stageLog: base.stageLog,
    budgetNotes: base.budgetNotes, note: base.note,
    minimizedInput: undefined, minimizedScript: undefined,
    finalVerify: null,
  };
}

function byteLen(s) { return Buffer.byteLength(s ?? '', 'utf8'); }

function detectJson(text) {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function classifyRepro(repro) {
  if (/\.(js|mjs|cjs)$/.test(repro) && !repro.includes('{input}')) {
    const basename = repro.split(/[\\/]/).pop();
    return { kind: 'script', path: repro, basename };
  }
  return { kind: 'shell' };
}

export { classifyRepro, detectJson };
