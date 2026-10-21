// code-min.js — line-based code minimization of the repro script itself
// (SPEC §6.2, v0 = line ddmin instead of AST). Safety rules:
//  - never remove lines that appear in the failure stack (script path:line)
//  - never remove the line that produces the signature
//  - invalid syntax is a REJECTED candidate, not a failure (node --check)
import { ddminLines } from './ddmin.js';
import { parseFrames } from './signature.js';
import { exec as realExec } from './exec.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { scratchDir } from './exec.js';
import { moduleTypeFor, mirrorModuleType } from './module-type.js';

/**
 * Which line numbers of `scriptText` appear in the failure output?
 * @returns {number[]} 1-based line numbers
 */
export function stackLines(scriptText, failureOutput, scriptBasename) {
  const frames = parseFrames(failureOutput).filter((f) => f.basename === scriptBasename);
  return [...new Set(frames.map((f) => f.line))];
}

/** Is this candidate syntactically valid JS? (via `node --check`) */
export async function syntaxOk(scriptText, { exec = realExec, ext = '.js', moduleType = 'commonjs' } = {}) {
  const scratch = scratchDir('minrepro-check-');
  try {
    const p = join(scratch.dir, `candidate${ext}`);
    writeFileSync(p, scriptText, 'utf8');
    if (moduleType === 'module') mirrorModuleType(scratch.dir, 'module');
    const res = await exec(process.execPath, ['--check', p], { cwd: scratch.dir, timeoutMs: 5000 });
    return res.code === 0;
  } finally {
    scratch.cleanup();
  }
}

/**
 * Minimize the repro script by removing lines.
 * @param {object} opts
 * @param {string} opts.scriptText
 * @param {(candidateText:string)=>Promise<{reproduces:boolean, output?:string}>} opts.probe
 *        probe must run the candidate and report whether the SAME failure
 *        signature still reproduces; `output` (stderr+stdout) feeds the
 *        protected-lines computation.
 * @param {string} opts.scriptBasename
 * @param {string[]} opts.initialStackLines 1-based lines from the original failure
 * @param {number} [opts.maxProbes]
 * @param {object} [opts.exec] injected exec for syntax checks
 * @param {object} [opts.log]
 */
export async function minimizeCode({
  scriptText, probe, scriptBasename, initialStackLines = [], maxProbes = 400, exec = realExec, log,
}) {
  const lines = scriptText.split(/\r?\n/);
  // protect lines that appear in the failure stack (0-based indexes)
  const protect = [...new Set(initialStackLines.map((n) => n - 1).filter((n) => n >= 0 && n < lines.length))];
  log?.info?.(`[code] protecting ${protect.length} stack line(s): ${protect.map((n) => n + 1).join(', ') || 'none'}`);

  // syntax gate in front of the oracle: invalid candidates never reach it
  let syntaxRejected = 0;
  const gatedProbe = async (candidateText) => {
    const ok = await syntaxOk(candidateText, { exec });
    if (!ok) {
      syntaxRejected += 1;
      return { reproduces: false };
    }
    return probe(candidateText);
  };

  const result = await ddminLines({
    text: scriptText,
    probe: gatedProbe,
    maxProbes,
    log,
    protect,
  });
  return { ...result, syntaxRejected, protectedLines: protect.map((n) => n + 1) };
}
