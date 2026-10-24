// bisect.js — git bisect integration (SPEC §7) using the minimized oracle.
// Pre-filter endpoints, bisect, verify the found commit ×N, and report
// honestly: "culprit (verified)" / "already fixed" / "inconclusive range".
import { exec as realExec, scratchDir } from './exec.js';
import { rmSync } from 'node:fs';

async function git(exec, repo, args, opts = {}) {
  const res = await exec('git', ['-C', repo, ...args], { timeoutMs: 30000, ...opts });
  if (res.code !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res;
}

/** Thrown by `spend()` when the probe budget is gone. Callers convert it into
 * an honest 'inconclusive' result — a budget exhaustion is a normal outcome,
 * not an internal error (SPEC §11: bounded, honest partial results). */
class BudgetStop extends Error {}

/** Honest 'inconclusive' result for a budget stop outside the narrow loop. */
function budgetStopResult(commits, probes, range, maxProbes, phase) {
  return {
    status: 'inconclusive', range, commits: commits.length, probesUsed: probes.used,
    message: `bisect budget exhausted (${probes.used}/${maxProbes} probes) ${phase} — no boundary found`,
  };
}

/**
 * Run a probe at a specific commit via a detached worktree.
 * @param {object} o
 * @param {string} o.repo
 * @param {string} o.sha
 * @param {(worktreeDir:string)=>Promise<{reproduces:boolean}>} o.runInWorktree
 * @param {Function} o.exec
 */
export async function probeAtCommit({ repo, sha, runInWorktree, exec = realExec }) {
  const scratch = scratchDir('minrepro-wt-');
  try {
    const wt = `${scratch.dir}/wt`;
    const add = await exec('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', wt, sha],
      { timeoutMs: 60000 });
    if (add.code !== 0) {
      // commit cannot be checked out (shouldn't happen) — treat as no-repro
      return { reproduces: false, error: add.stderr || add.stdout };
    }
    try {
      return await runInWorktree(wt);
    } finally {
      await git(exec, repo, ['worktree', 'remove', '--force', wt], { allowFail: true });
      await git(exec, repo, ['worktree', 'prune'], { allowFail: true });
    }
  } finally {
    scratch.cleanup();
  }
}

/**
 * Bisect a range for the first commit where the oracle reproduces.
 * @param {object} o
 * @param {string} o.repo          git directory
 * @param {string} o.range         e.g. "v1.0.0..HEAD"
 * @param {(sha:string, wt:string|null)=>Promise<{reproduces:boolean}>} o.probe
 *        probe(sha) — run the minimized oracle at that commit
 * @param {number} [o.verifyRuns]  re-verify culprit N times (default 3)
 * @param {number} [o.maxProbes]   budget (default 60, SPEC §11)
 * @param {Function} [o.exec]
 * @param {object} [o.log]
 */
export async function bisect({ repo, range, probe, verifyRuns = 3, maxProbes = 60, exec = realExec, log }) {
  const revsRes = await git(exec, repo, ['rev-list', '--reverse', range]);
  const commits = revsRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const probes = { used: 0, max: maxProbes };
  const spend = () => { if (probes.used >= probes.max) throw new BudgetStop(); probes.used += 1; };

  const info = async (sha) => {
    // %x1f = unit separator; subjects can legitimately contain '|' (and even
    // tabs), so '\x1f' is the safe delimiter. Subject keeps the remainder so
    // a subject containing the separator still renders whole.
    const res = await git(exec, repo, ['show', '-s', '--format=%h%x1f%s%x1f%cs', sha]);
    const parts = res.stdout.trim().split('\x1f');
    return { sha, short: parts[0], subject: parts.slice(1, -1).join('\x1f') || parts[1], date: parts[parts.length - 1] };
  };

  if (commits.length === 0) {
    return { status: 'empty-range', range, commits: 0, probesUsed: 0, message: `no commits in range ${range}` };
  }
  if (commits.length === 1) {
    // single commit: is it bad?
    try {
      spend();
      const r = await probe(commits[0], null);
      const meta = await info(commits[0]);
      if (r.reproduces) return { status: 'culprit', culprit: meta, probesUsed: probes.used, verified: {runs: 0}, range, commits: 1 };
      return { status: 'no-repro', probesUsed: probes.used, range, commits: 1, message: 'oracle does not reproduce at the only commit in range' };
    } catch (e) {
      if (!(e instanceof BudgetStop)) throw e;
      return budgetStopResult(commits, probes, range, maxProbes, 'at the only commit in range');
    }
  }

  const first = commits[0];
  const last = commits[commits.length - 1];

  // pre-filter endpoints (SPEC §7.2) — budget exhaustion here is an honest
  // inconclusive, not a crash (spend() throws before any state is kept).
  let firstBad; let lastBad;
  try {
    spend();
    firstBad = (await probe(first, null)).reproduces;
    spend();
    lastBad = (await probe(last, null)).reproduces;
  } catch (e) {
    if (!(e instanceof BudgetStop)) throw e;
    return budgetStopResult(commits, probes, range, maxProbes, 'during endpoint pre-filter');
  }

  if (!firstBad && !lastBad) {
    return {
      status: 'already-fixed', range, commits: commits.length, probesUsed: probes.used,
      message: `oracle does not reproduce at either end of ${range} — already fixed (or never broken here)`,
      endpoints: { first: await info(first), last: await info(last) },
    };
  }
  if (firstBad && lastBad) {
    return {
      status: 'inconclusive', range, commits: commits.length, probesUsed: probes.used,
      message: `oracle reproduces at BOTH ends of ${range} — bug predates the range; extend it backwards`,
      endpoints: { first: await info(first), last: await info(last) },
    };
  }
  if (firstBad && !lastBad) {
    // bug present at range start, gone at range end: it was fixed inside the
    // range (or the oracle is flaky). Report honestly; v0 does not bisect
    // for the FIX commit.
    return {
      status: 'already-fixed', range, commits: commits.length, probesUsed: probes.used,
      message: `oracle reproduces at the START of ${range} but not at HEAD — already fixed inside the range (v0 does not bisect for fix commits)`,
      endpoints: { first: await info(first), last: await info(last) },
    };
  }
  // standard invariant: first good, last bad — find boundary
  let lo = 0;           // index of known-good commit
  let hi = commits.length - 1; // index of known-bad commit
  try {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      spend();
      const bad = (await probe(commits[mid], null)).reproduces;
      if (bad) hi = mid; else lo = mid;
      log?.info?.(`[bisect] ${probes.used} probes: good=${commits[lo].slice(0, 7)} bad=${commits[hi].slice(0, 7)}`);
    }
  } catch (e) {
    if (!(e instanceof BudgetStop)) throw e;
    return {
      status: 'inconclusive', range, commits: commits.length, probesUsed: probes.used,
      message: `bisect budget exhausted (${maxProbes} probes); narrowed to ${commits[lo].slice(0, 7)}..${commits[hi].slice(0, 7)}`,
      narrowedRange: { good: commits[lo], bad: commits[hi] },
    };
  }

  const culpritSha = commits[hi];
  // verify the culprit N times (SPEC §7.6) and the parent stays good ×N
  let verifiedRuns = 0;
  try {
    for (let i = 0; i < verifyRuns; i++) {
      spend();
      const r = await probe(culpritSha, null);
      if (!r.reproduces) {
        return {
          status: 'inconclusive', range, commits: commits.length, probesUsed: probes.used,
          message: `culprit ${culpritSha.slice(0, 7)} did not reproduce on re-verification (${i}/${verifyRuns}) — flaky oracle or bad bisect; not claiming a commit`,
        };
      }
      verifiedRuns += 1;
    }
  } catch (e) {
    if (!(e instanceof BudgetStop)) throw e;
    return {
      status: 'inconclusive', range, commits: commits.length, probesUsed: probes.used,
      message: `bisect budget exhausted (${probes.used}/${maxProbes} probes) while verifying the culprit ${culpritSha.slice(0, 7)} — ${verifiedRuns}/${verifyRuns} verification runs completed`,
      narrowedRange: { good: commits[lo], bad: commits[hi] },
    };
  }
  const culprit = await info(culpritSha);
  const parent = await info(commits[lo]);
  return {
    status: 'culprit', culprit, parent,
    verified: { runs: verifiedRuns, total: verifyRuns },
    range, commits: commits.length, probesUsed: probes.used,
    message: `culprit ${culprit.short} "${culprit.subject}" — verified ${verifiedRuns}/${verifyRuns} probes; range narrowed from ${commits.length} commits`,
  };
}

export { probeAtCommit as runAtCommit };