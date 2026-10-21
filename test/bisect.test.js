import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bisect, probeAtCommit } from '../src/bisect.js';
import { exec } from '../src/exec.js';
import { runNode, tempDir, write } from './helpers.js';

// git needs the full host environment (HOME/USERPROFILE/system config)
const gitExec = (file, args, opts = {}) => exec(file, args, { ...opts, env: { ...process.env } });

const GOOD = "module.exports = () => 'ok';\n";
const BAD = "module.exports = () => { throw new Error('BISECT_MARK broke'); };\n";

/** Build a throwaway git repo; isBad(i) decides the content of commit i. */
async function makeRepo(count, isBad) {
  const scratch = tempDir('minrepro-git-');
  const repo = join(scratch.dir, 'repo');
  mkdirSync(repo);
  const git = async (...args) => {
    const res = await gitExec('git', ['-C', repo, ...args], { timeoutMs: 30000 });
    if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    return res;
  };
  await gitExec('git', ['init', '-q', repo]);
  await git('config', 'user.email', 'minrepro-test@example.com');
  await git('config', 'user.name', 'minrepro test');
  await git('config', 'commit.gpgsign', 'false');
  const shas = [];
  for (let i = 0; i < count; i++) {
    const bad = isBad(i);
    // tag each commit with a unique marker so consecutive same-state commits
    // (e.g. two good-in-a-row) still produce a real diff, not an empty commit
    write(repo, 'bug.js', (bad ? BAD : GOOD) + `// rev ${i}\n`);
    await git('add', '-A');
    await git('commit', '-q', '-m', bad ? 'introduce the bug' : `change ${i}`);
    shas.push((await git('rev-parse', 'HEAD')).stdout.trim());
  }
  return { scratch, repo, shas };
}

/** The minimized oracle: does bug.js throw when required AND invoked from a worktree? */
const runInWorktree = async (wt) => {
  const res = await runNode(['-e', "require('./bug.js')()"], { cwd: wt });
  return { reproduces: res.code !== 0 };
};
const probeVia = (repo) => (sha) => probeAtCommit({ repo, sha, exec: gitExec, runInWorktree });

// repoA: 8 commits, bug introduced at commit #6 (index 5) and still present
const repoA = await makeRepo(8, (i) => i >= 5);
// repoB: 4 commits, buggy from the start
const repoB = await makeRepo(4, () => true);
// repoC: 8 commits, bug introduced at #6 and FIXED again at #8
const repoC = await makeRepo(8, (i) => i === 5 || i === 6);

after(() => {
  repoA.scratch.cleanup();
  repoB.scratch.cleanup();
  repoC.scratch.cleanup();
});

test('bisect finds the culprit commit and re-verifies it x3', async () => {
  const result = await bisect({
    repo: repoA.repo, range: 'HEAD', probe: probeVia(repoA.repo), verifyRuns: 3,
    exec: gitExec,
  });
  assert.equal(result.status, 'culprit');
  assert.equal(result.culprit.sha, repoA.shas[5]);
  assert.equal(result.culprit.subject, 'introduce the bug');
  assert.equal(result.parent.sha, repoA.shas[4]);
  assert.deepEqual(result.verified, { runs: 3, total: 3 });
  assert.equal(result.commits, 8);
  // 2 endpoint probes + 3 binary-search probes + 3 verification probes
  assert.equal(result.probesUsed, 8);
  assert.ok(result.message.includes('verified 3/3 probes'));
  assert.match(result.culprit.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('bisect reports "already fixed" when neither range endpoint fails', async () => {
  // commits 4..7 of repoC: good, bad, bad, good -> endpoints both good
  const range = `${repoC.shas[3]}..HEAD`;
  const result = await bisect({
    repo: repoC.repo, range, probe: probeVia(repoC.repo), verifyRuns: 1, exec: gitExec,
  });
  assert.equal(result.status, 'already-fixed');
  assert.match(result.message, /does not reproduce at either end/);
  assert.equal(result.probesUsed, 2);
});

test('bisect reports "inconclusive" when both endpoints fail (bug predates range)', async () => {
  const result = await bisect({
    repo: repoB.repo, range: 'HEAD', probe: probeVia(repoB.repo), verifyRuns: 1, exec: gitExec,
  });
  assert.equal(result.status, 'inconclusive');
  assert.match(result.message, /BOTH ends/);
  assert.equal(result.probesUsed, 2);
});

test('bisect handles an empty range', async () => {
  const empty = await bisect({
    repo: repoB.repo, range: 'HEAD..HEAD', probe: probeVia(repoB.repo), exec: gitExec,
  });
  assert.equal(empty.status, 'empty-range');
  assert.equal(empty.commits, 0);
  assert.equal(empty.probesUsed, 0);
});

test('probeAtCommit runs inside a detached worktree and cleans it up', async () => {
  const seen = [];
  let wtExistedDuringRun = false;
  let wtExistsAfterRun = null;
  const r = await probeAtCommit({
    repo: repoA.repo, sha: repoA.shas[1], exec: gitExec,
    runInWorktree: async (wt) => {
      seen.push(wt);
      wtExistedDuringRun = existsSync(wt);
      const res = await runNode(['-e', 'process.stdout.write(process.cwd())'], { cwd: wt });
      return { reproduces: false, cwd: res.stdout };
    },
  });
  wtExistsAfterRun = seen[0] ? existsSync(seen[0]) : null;
  assert.equal(r.reproduces, false);
  assert.equal(seen.length, 1);
  // the worktree was a real detached checkout present during the run...
  assert.ok(wtExistedDuringRun, 'worktree dir must exist while probing');
  // ...and probeAtCommit removed it afterwards
  assert.equal(wtExistsAfterRun, false, 'worktree dir must be cleaned up');
});
