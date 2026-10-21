// artifacts.js — write the repro/ directory (SPEC §8):
// minimized input, minimized script, run.sh + run.cmd one-liners,
// report.md (confidence badge, before/after table, culprit, run
// instructions) and repro.json (machine state: probe counts, budgets,
// stage accept/reject logs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { humanBytes } from './util.js';

const EXIT_MEANING = {
  0: 'repro produced and verified (deterministic)',
  1: 'partial: smallest achieved, documented in this report',
  2: 'usage error',
  3: 'could not reproduce',
  4: 'unsupported environment',
};

export function confidenceBadge(calibration) {
  if (!calibration) return { line: '**Confidence:** not calibrated', deterministic: false };
  const { matched, total, flaky } = calibration;
  if (!flaky && matched === total) {
    return { line: `**Confidence:** ${matched}/${total} runs · deterministic ✅`, deterministic: true };
  }
  if (flaky) {
    return { line: `**Confidence:** ⚠️ FLAKY MODE — reproduced ${matched}/${total} runs · do not treat as deterministic`, deterministic: false };
  }
  return { line: `**Confidence:** ❌ could not reproduce (${matched}/${total} runs)`, deterministic: false };
}

/**
 * Build the before/after table rows from stage results.
 * @param {object} state
 */
export function beforeAfterRows(state) {
  const rows = [];
  const { input, code, env } = state.stages;
  if (input) {
    rows.push(['input', `${input.before.bytes} B (${input.before.chars} chars)`,
      `${input.after.bytes} B (${input.after.chars} chars)`, `${input.probes} probes (${input.accepted} accepted)`]);
    if (input.strategy) rows[rows.length - 1][0] = `input (${input.strategy})`;
  }
  if (code) {
    rows.push(['repro script', `${code.before.lines} lines`, `${code.after.lines} lines`,
      `${code.probes} probes, ${code.syntaxRejected} syntax-rejected`]);
  }
  if (env) {
    rows.push(['env vars (removable)', `${env.before.count}`, `${env.after.count}`,
      `${env.probes} probes`]);
  }
  return rows;
}

/**
 * Render report.md (SPEC §8).
 * @param {object} state full run state
 */
export function renderReport(state) {
  const badge = confidenceBadge(state.calibration);
  const L = [];
  L.push(`# Reproduction: ${state.title}`);
  L.push('');
  L.push(badge.line);
  L.push('');
  if (state.calibration && !badge.deterministic) {
    L.push(`> ⚠️ This oracle reproduced the target failure in ${state.calibration.matched} of `
      + `${state.calibration.total} calibration runs. Everything below inherits that uncertainty.`);
    L.push('');
  }

  // minimal repro
  if (state.minimizedScript) {
    const beforeLines = state.stages.code?.before.lines ?? state.minimizedScript.split('\n').length;
    L.push(`## Minimal reproduction (${state.minimizedScript.split('\n').length} lines, was ${beforeLines})`);
    L.push('');
    L.push('```js');
    L.push(state.minimizedScript.trimEnd());
    L.push('```');
    L.push('');
  }
  if (state.minimizedInput !== undefined) {
    L.push('## Minimal input');
    L.push('');
    L.push('```json');
    L.push(state.minimizedInput.trimEnd());
    L.push('```');
    L.push('');
  }

  // before/after table
  const rows = beforeAfterRows(state);
  if (rows.length) {
    L.push('## What we removed');
    L.push('');
    L.push('| Dimension | Before | After | Cost |');
    L.push('|-----------|--------|-------|------|');
    for (const r of rows) L.push(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
    L.push('');
  }

  // failure signature
  if (state.signature) {
    L.push('## Failure signature (normalized)');
    L.push('');
    L.push('```');
    L.push(state.signature.normalized);
    L.push('```');
    L.push('');
  }

  // culprit commit
  if (state.bisect) {
    L.push('## Culprit commit');
    L.push('');
    const b = state.bisect;
    if (b.status === 'culprit') {
      L.push(`\`${b.culprit.short} "${b.culprit.subject}"\` (${b.culprit.date}) `
        + `— verified at ${b.verified.runs}/${b.verified.total} probes`);
      L.push(`introduced-by range narrowed from ${b.commits} commits (${b.range})`);
    } else {
      L.push(`Bisect outcome: **${b.status}**`);
      L.push('');
      L.push(b.message);
    }
    L.push('');
  }

  // verification section
  if (state.finalVerify) {
    L.push('## Final verification');
    L.push('');
    L.push(`Minimized artifact reproduced ${state.finalVerify.matched}/${state.finalVerify.total} runs.`);
    L.push('');
  }

  // run instructions
  L.push('## Run it');
  L.push('');
  L.push('```sh');
  L.push('./run.sh      # POSIX: exit code = bug present (nonzero = reproduced)');
  L.push('run.cmd       # Windows');
  L.push('```');
  L.push('');
  L.push('Or: `minrepro verify repro/` re-runs the artifact N times and reports counts.');
  L.push('');

  // budget / honesty section
  if (state.budgetNotes?.length) {
    L.push('## Budget & honesty notes');
    L.push('');
    for (const n of state.budgetNotes) L.push(`- ${n}`);
    L.push('');
  }

  // stage log
  if (state.stageLog?.length) {
    L.push('## Stage log');
    L.push('');
    L.push('```');
    for (const line of state.stageLog) L.push(line);
    L.push('```');
    L.push('');
  }

  L.push('---');
  L.push(`Generated by minrepro v0 · exit code ${state.exitCode} = ${EXIT_MEANING[state.exitCode] ?? 'unknown'}`);
  L.push('');
  return L.join('\n');
}

/**
 * Write the full artifact set into outDir.
 * @returns {{dir:string, files:string[]}}
 */
export function writeArtifacts({ outDir, state, inputExt = '.json' }) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  const inputName = `input.min${inputExt}`;
  const scriptName = 'repro.js';
  if (state.minimizedInput !== undefined) {
    writeFileSync(join(outDir, inputName), state.minimizedInput, 'utf8');
    files.push(inputName);
  }
  if (state.minimizedScript !== undefined) {
    writeFileSync(join(outDir, scriptName), state.minimizedScript, 'utf8');
    files.push(scriptName);
  }
  const runSh = `#!/usr/bin/env sh\n# minrepro artifact: exit code = bug present (nonzero = reproduced)\ncd "$(dirname "$0")"\nexec node ${scriptName} "${inputName}"\n`;
  writeFileSync(join(outDir, 'run.sh'), runSh, 'utf8');
  files.push('run.sh');
  const runCmd = `@echo off\r\nrem minrepro artifact: exit code = bug present (nonzero = reproduced)\r\ncd /d "%~dp0"\r\nnode ${scriptName} "${inputName}"\r\n`;
  writeFileSync(join(outDir, 'run.cmd'), runCmd, 'utf8');
  files.push('run.cmd');

  const report = renderReport(state);
  writeFileSync(join(outDir, 'report.md'), report, 'utf8');
  files.push('report.md');

  const reproJson = {
    tool: 'minrepro',
    version: '0.1.0',
    exitCode: state.exitCode,
    exitMeaning: EXIT_MEANING[state.exitCode] ?? 'unknown',
    title: state.title,
    createdAt: new Date().toISOString(),
    calibration: state.calibration,
    signature: state.signature,
    stages: state.stages,
    budgets: state.budgets ?? null,
    bisect: state.bisect ?? null,
    finalVerify: state.finalVerify ?? null,
    // env-gated bugs: the minimized extra env vars the artifact needs
    // (without these, `minrepro verify` cannot reproduce env-gated artifacts)
    extraEnv: state.extraEnv ?? null,
    files: { script: scriptName, input: inputName, runSh: 'run.sh', runCmd: 'run.cmd' },
    probeStats: state.probeStats ?? null,
  };
  writeFileSync(join(outDir, 'repro.json'), JSON.stringify(reproJson, null, 2), 'utf8');
  files.push('repro.json');
  return { dir: outDir, files };
}

export { humanBytes };
