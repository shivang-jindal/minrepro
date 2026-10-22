#!/usr/bin/env node
// cli.js — minrepro v0 CLI (SPEC §2, v0 subset):
//   minrepro run --repro <script|cmd> --input <file> [...]
//   minrepro verify <artifact-dir> [-n N]
//   minrepro bisect --repo <git-dir> --repro <script> --input <file> --range <a..b>
// Exit codes: 0 verified repro · 1 partial-minimized · 2 usage · 3 could-not-reproduce.
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, classifyRepro } from './pipeline.js';
import { Oracle } from './oracle.js';
import { bisect, probeAtCommit } from './bisect.js';
import { failureSignature } from './signature.js';
import { writeArtifacts } from './artifacts.js';
import { exec as realExec } from './exec.js';

const VERSION = '0.1.0';

const HELP = `minrepro v${VERSION} — turn a flaky bug report into a minimal, deterministic reproduction

Usage:
  minrepro run --repro <script.js|cmd> --input <file> [options]
  minrepro verify <artifact-dir> [-n <runs>]
  minrepro bisect --repo <git-dir> --repro <script.js> --input <file> --range <a..b>
  minrepro --help | --version

run options:
  --repro <path|cmd>      script that exits nonzero on the failure, or a shell
                          command ({input} placeholder or appended input path)
  --input <file>          the original failing input (JSON shrunk structurally,
                          anything else via line-ddmin)
  --stages <list>         comma list of input,code,env (default: all)
  --max-probes <n>        input-stage probe budget (default 300)
  --code-max-probes <n>   code-stage probe budget (default 400)
  --env-max-probes <n>    env-stage probe budget (default 150)
  --calibration <n>       determinism-harness runs (default 10)
  --verify <n>            final verification runs (default 10)
  --timeout <ms>          per-probe timeout (default 10000)
  --out <dir>             artifact directory (default repro)
  --title <name>          report title (default: the repro path)
  --report-format <md|json>  report flavor (default md: report.md; json:
                           machine-readable report.json, no report.md)
  --quiet                 suppress progress output

verify options:
  -n, --runs <n>          re-run count (default 10)
  --timeout <ms>          per-run timeout (default 10000)

bisect options:
  --repo <dir>            git repository
  --range <a..b>          commit range (e.g. v1.0.0..HEAD)
  --repro / --input       the MINIMIZED oracle (from \`minrepro run\`)
  --oracle <dir>          shortcut: use repro/ artifacts written by \`run\`
  --verify <n>            re-verify culprit N times (default 3)
  --max-probes <n>        bisect probe budget (default 60)
  --out <dir>             artifact directory (default repro)

Exit codes:
  0  repro produced and verified
  1  partial (smallest achieved, documented in report.md)
  2  usage error
  3  could not reproduce
`;

function usageError(msg) {
  process.stderr.write(`minrepro: ${msg}\nRun \`minrepro --help\` for usage.\n`);
  return 2;
}

/** Minimal flag parser: --key value, --flag, positional args. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const wantsValue = new Set([
    'repro', 'input', 'stages', 'max-probes', 'code-max-probes', 'env-max-probes',
    'calibration', 'verify', 'timeout', 'out', 'title', 'repo', 'range', 'oracle',
    'runs', 'n', 'report-format',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { flags.help = true; continue; }
    if (a === '--version' || a === '-V') { flags.version = true; continue; }
    if (a === '--quiet') { flags.quiet = true; continue; }
    if (a === '--keep-temp') { flags['keep-temp'] = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (wantsValue.has(key)) {
        const v = argv[++i];
        if (v === undefined) throw new Error(`flag --${key} requires a value`);
        flags[key] = v;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (/^-n\d+$/.test(a)) { flags.runs = a.slice(2); continue; }
    if (a === '-n') { const v = argv[++i]; if (v === undefined) throw new Error('flag -n requires a value'); flags.runs = v; continue; }
    positional.push(a);
  }
  return { flags, positional };
}

const int = (v, dflt) => (v === undefined ? dflt : (Number.isFinite(Number(v)) ? Number(v) : NaN));

async function cmdRun(flags) {
  if (!flags.repro || !flags.input) return usageError('run requires --repro and --input');
  const reportFormat = flags['report-format'] ?? 'md';
  if (!['md', 'json'].includes(reportFormat)) {
    return usageError(`--report-format must be md or json (got ${reportFormat})`);
  }
  if (!existsSync(flags.input)) return usageError(`input file not found: ${flags.input}`);
  const scriptCheck = classifyRepro(flags.repro);
  if (scriptCheck.kind === 'script' && !existsSync(scriptCheck.path)) {
    return usageError(`repro script not found: ${flags.repro}`);
  }
  const stages = flags.stages ? flags.stages.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  if (stages) {
    for (const s of stages) {
      if (!['input', 'code', 'env'].includes(s)) return usageError(`unknown stage: ${s} (expected input, code, env)`);
    }
  }
  const maxProbes = int(flags['max-probes'], 300);
  const codeMaxProbes = int(flags['code-max-probes'], 400);
  const envMaxProbes = int(flags['env-max-probes'], 150);
  const calibration = int(flags.calibration, 10);
  const verify = int(flags.verify, 10);
  const timeout = int(flags.timeout, 10000);
  for (const [name, v] of Object.entries({ 'max-probes': maxProbes, 'code-max-probes': codeMaxProbes, 'env-max-probes': envMaxProbes, calibration, verify, timeout })) {
    if (!Number.isFinite(v) || v <= 0) return usageError(`--${name} must be a positive number`);
  }
  const { exitCode } = await runPipeline({
    repro: flags.repro,
    input: flags.input,
    stages,
    maxProbes,
    codeMaxProbes,
    envMaxProbes,
    calibrationRuns: calibration,
    verifyRuns: verify,
    timeoutMs: timeout,
    outDir: flags.out ?? 'repro',
    title: flags.title,
    reportFormat,
    quiet: !!flags.quiet,
  });
  return exitCode;
}

async function cmdVerify(positional, flags) {
  const dir = positional[0];
  if (!dir) return usageError('verify requires an artifact directory');
  const jsonPath = join(dir, 'repro.json');
  if (!existsSync(jsonPath)) return usageError(`no repro.json in ${dir} — is this a minrepro artifact dir?`);
  const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const runs = int(flags.runs ?? flags.verify, 10);
  const timeout = int(flags.timeout, 10000);
  if (!Number.isFinite(runs) || runs <= 0) return usageError('--runs must be a positive number');
  const scriptPath = join(dir, meta.files?.script ?? 'repro.js');
  const inputPath = join(dir, meta.files?.input ?? 'input.min.json');
  if (!existsSync(scriptPath) || !existsSync(inputPath)) {
    process.stderr.write(`minrepro verify: missing ${scriptPath} or ${inputPath}\n`);
    return 3;
  }
  const oracle = new Oracle({
    repro: scriptPath, inputText: readFileSync(inputPath, 'utf8'),
    inputName: inputPath, exec: realExec, timeoutMs: timeout,
  });
  oracle.signature = meta.signature;
  let matched = 0;
  for (let i = 0; i < runs; i++) {
    // replay with the artifact's minimized env (env-gated bugs need it)
    const r = await oracle.probeCandidate(oracle.inputText, { env: meta.extraEnv ?? {} });
    if (r.reproduces) matched += 1;
  }
  process.stdout.write(`minrepro verify: reproduced ${matched}/${runs} runs `
    + `(signature: ${meta.signature?.kind ?? 'unknown'})\n`);
  if (matched === runs) return 0;
  if (matched > 0) return 1;
  return 3;
}

async function cmdBisect(flags) {
  if (!flags.repo || !flags.range) return usageError('bisect requires --repo and --range');
  if (!existsSync(flags.repo)) return usageError(`repo not found: ${flags.repo}`);
  let repro = flags.repro;
  let input = flags.input;
  if (flags.oracle) {
    const metaPath = join(flags.oracle, 'repro.json');
    if (!existsSync(metaPath)) return usageError(`no repro.json in ${flags.oracle}`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    repro = repro ?? join(flags.oracle, meta.files?.script ?? 'repro.js');
    input = input ?? join(flags.oracle, meta.files?.input ?? 'input.min.json');
  }
  if (!repro || !input) return usageError('bisect requires --repro and --input (or --oracle <dir>)');
  if (!existsSync(input)) return usageError(`input file not found: ${input}`);
  const verifyRuns = int(flags.verify, 3);
  const maxProbes = int(flags['max-probes'], 60);
  const timeout = int(flags.timeout, 10000);

  const inputText = readFileSync(input, 'utf8');
  const inputAbs = isAbsolute(input) ? input : resolve(input);
  const scriptInfo = classifyRepro(repro);
  const reproAbs = scriptInfo.kind === 'script' ? (isAbsolute(repro) ? repro : resolve(repro)) : repro;

  // The minimized oracle: run the repro at a given worktree (or plain cwd).
  const oracleAt = async (worktreeDir) => {
    const scratch = await import('./exec.js').then((m) => m.scratchDir('minrepro-bioracle-'));
    try {
      const { writeFileSync } = await import('node:fs');
      const { join: j } = await import('node:path');
      const inPath = j(scratch.dir, 'input.json');
      writeFileSync(inPath, inputText, 'utf8');
      let file; let args;
      if (scriptInfo.kind === 'script') {
        file = process.execPath;
        // run the repro from inside the worktree so relative imports see the
        // checkout under test; fall back to the artifact copy if absent there
        const { existsSync: ex } = await import('node:fs');
        const inWt = worktreeDir ? j(worktreeDir, scriptInfo.basename) : null;
        args = [ex(inWt) ? inWt : reproAbs, inPath];
      } else {
        file = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
        const cmd = reproAbs.includes('{input}') ? reproAbs.replaceAll('{input}', `"${inPath}"`) : `${reproAbs} "${inPath}"`;
        args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
      }
      const res = await realExec(file, args, { cwd: worktreeDir ?? scratch.dir, timeoutMs: timeout });
      const sig = failureSignature(res, { scriptBasename: scriptInfo.basename });
      const isFail = res.timedOut || res.signal !== null || (res.code ?? 0) !== 0;
      return { reproduces: isFail, signature: sig, result: res };
    } finally {
      scratch.cleanup();
    }
  };

  const probe = async (sha) => probeAtCommit({
    repo: flags.repo, sha, exec: realExec,
    runInWorktree: (wt) => oracleAt(wt),
  });

  const result = await bisect({
    repo: flags.repo, range: flags.range, probe, verifyRuns, maxProbes, exec: realExec,
    log: { info: (m) => { if (!flags.quiet) process.stdout.write(m + '\n'); } },
  });

  const exitCode = result.status === 'culprit' || result.status === 'already-fixed' ? 0
    : result.status === 'no-repro' ? 3 : 1;

  // write artifacts next to the oracle dir when possible
  const outDir = flags.out ?? (flags.oracle ? flags.oracle : 'repro');
  const state = {
    title: `bisect ${flags.range} (${flags.repo})`,
    exitCode,
    calibration: null,
    signature: null,
    stages: {},
    minimizedInput: undefined,
    minimizedScript: undefined,
    bisect: result,
    stageLog: [`[bisect] ${result.message}`],
    budgetNotes: result.status === 'inconclusive'
      ? [`bisect inconclusive: ${result.message}`] : [],
    finalVerify: null,
  };
  writeArtifacts({ outDir, state, inputExt: '.json' });
  process.stdout.write(`minrepro bisect: ${result.message}\n`);
  process.stdout.write(`Artifacts: ${outDir}/report.md\n`);
  return exitCode;
}

export async function main(argv, deps = {}) {
  const execOut = deps.stdout ?? ((s) => process.stdout.write(s));
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return usageError(e.message);
  }
  const { flags, positional } = parsed;
  if (flags.version) { execOut(`minrepro ${VERSION}\n`); return 0; }
  if (flags.help || positional.length === 0) { execOut(HELP); return flags.help || positional.length === 0 ? 0 : 2; }
  const cmd = positional[0];
  const restPos = positional.slice(1);
  switch (cmd) {
    case 'run': return cmdRun(flags);
    case 'verify': return cmdVerify(restPos, flags);
    case 'bisect': return cmdBisect(flags);
    case '--help': case '-h': case 'help': execOut(HELP); return 0;
    case '--version': case '-V': execOut(`minrepro ${VERSION}\n`); return 0;
    default: return usageError(`unknown command: ${cmd}`);
  }
}

// run when invoked directly
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`minrepro: internal error: ${e?.stack || e}\n`);
    process.exitCode = 1;
  });
}
