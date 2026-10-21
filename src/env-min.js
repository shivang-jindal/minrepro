// env-min.js — environment minimization (SPEC §6.3): delta-debug the set of
// non-essential env vars from the captured launch environment. Allowlisted
// harness vars (PATH, SYSTEMROOT, ...) always stay; everything else must
// prove it is needed by reproducing the failure without it being removed.
import { ddminLines } from './ddmin.js';
import { ENV_ALLOWLIST, cleanEnv } from './exec.js';

/** Names (case-insensitive on Windows) that never get removed. */
export function allowlisted(name) {
  return ENV_ALLOWLIST.some((a) => a.toLowerCase() === name.toLowerCase());
}

/**
 * Capture the launch environment minus allowlisted harness vars.
 * These are the candidates for removal.
 */
export function captureRemovable(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => !allowlisted(k) && v !== undefined)
    // multi-line values cannot round-trip through line-based ddmin; keep them
    .filter(([, v]) => !/[\r\n]/.test(String(v)))
    .map(([k, v]) => ({ name: k, value: String(v) }));
}

/**
 * Minimize env vars.
 * @param {object} opts
 * @param {{name:string,value:string}[]} opts.vars removable vars (captured)
 * @param {(env:Object)=>Promise<{reproduces:boolean}>} opts.probe probe with a
 *        full env object (allowlist + candidate subset)
 * @param {number} [opts.maxProbes]
 * @param {object} [opts.log]
 * @returns {Promise<{kept:object, keptNames:string[], exhausted:boolean,
 *   exhaustedReason:string|null, probesAccepted:number, probesRejected:number,
 *   nextCandidates:string[]}>}
 */
export async function minimizeEnv({ vars, probe, maxProbes = 150, log }) {
  // reuse ddmin machinery on a "line list" of NAME=VALUE entries
  const entries = vars.map((v) => `${v.name}=${v.value}`);
  const names = vars.map((v) => v.name);
  const envFor = (keptIdx) => {
    const env = {};
    for (const i of keptIdx) env[names[i]] = vars[i].value;
    return env;
  };
  const result = await ddminLines({
    text: entries.join('\n'),
    probe: async (candidateText) => {
      const wanted = new Set(candidateText.split('\n').filter(Boolean));
      const keptIdx = [];
      entries.forEach((e, i) => { if (wanted.has(e)) keptIdx.push(i); });
      return probe(envFor(keptIdx));
    },
    maxProbes,
    log,
  });
  const kept = {};
  for (const i of result.keptLines) kept[names[i]] = vars[i].value;
  log?.info?.(`[env] ${vars.length} removable var(s) -> ${result.keptLines.length} kept`);
  return {
    kept,
    keptNames: result.keptLines.map((i) => names[i]),
    exhausted: result.exhausted,
    exhaustedReason: result.exhaustedReason,
    probesAccepted: result.probesAccepted,
    probesRejected: result.probesRejected,
    nextCandidates: result.nextCandidates,
  };
}

/** Full env a probe should run with: allowlist + minimized extras. */
export function probeEnv(extra = {}) {
  return { ...cleanEnv(extra) };
}
