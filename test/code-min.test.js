import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { minimizeCode, stackLines, syntaxOk } from '../src/code-min.js';
import { runNode, tempDir, write } from './helpers.js';

// 9-line repro: 2 dead lines around a 7-line failure. The throw (line 6)
// and the call site (line 8) appear in the failure stack and must survive
// minimization; `function boom`'s braces must survive the syntax gate.
const SCRIPT = `const fs = require('node:fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
const deadA = 'noise-one';
const deadB = 42;
function boom(input) {
  throw new Error('CODEMIN_MARK: ' + input.trim());
}
boom(raw);
console.log('pad ran');
`;

/**
 * Documented `exec` dependency for minimizeCode's syntax gate: answers
 * `node --check <file>` requests with an in-process parse so one unit test
 * does not pay a process launch per candidate (the real `node --check` path
 * is covered by the syntaxOk tests below and by the pipeline e2e).
 */
const inProcessCheck = async (_file, args) => {
  const candidate = readFileSync(args[args.length - 1], 'utf8');
  try {
    new Function(candidate);
    return { code: 0 };
  } catch {
    return { code: 1 };
  }
};

function validSyntax(text) {
  try { new Function(text); return true; } catch { return false; }
}

/** Oracle stand-in: runs the candidate for real; same failure iff CODEMIN_MARK. */
function makeProbe() {
  const seen = [];
  const verdicts = new Map();
  const probe = async (candidateText) => {
    const scratch = tempDir('minrepro-cm-');
    try {
      const scriptPath = write(scratch.dir, 'repro.js', candidateText);
      const inputPath = write(scratch.dir, 'in.txt', 'hello\n');
      const res = await runNode([scriptPath, inputPath], { cwd: scratch.dir });
      const out = (res.stderr || '') + (res.stdout || '');
      // require the actual thrown message — a bare includes() would also match
      // the failing source line Node echoes back in its error context block
      const reproduces = res.code !== 0 && /Error: CODEMIN_MARK/.test(out);
      seen.push(candidateText);
      verdicts.set(candidateText, reproduces);
      return { reproduces, output: out };
    } finally {
      scratch.cleanup();
    }
  };
  return { probe, seen, verdicts };
}

test('stackLines extracts the 1-based script line numbers from a failure stack', () => {
  const output = [
    'Error: CODEMIN_MARK: hello',
    '    at boom (C:\\tmp\\minrepro-probe-x\\repro.js:6:9)',
    '    at Object.<anonymous> (C:\\tmp\\minrepro-probe-x\\repro.js:8:1)',
    '    at node:internal/main/run_main_module:24:10',
  ].join('\n');
  assert.deepEqual(stackLines(SCRIPT, output, 'repro.js'), [6, 8]);
  assert.deepEqual(stackLines(SCRIPT, output, 'other.js'), []);
});

test('minimizeCode strips dead lines, gates invalid candidates, stays reproducing', async () => {
  const { probe, seen, verdicts } = makeProbe();
  // one real failure run derives the protected stack lines
  const first = await probe(SCRIPT);
  assert.equal(first.reproduces, true, 'fixture must reproduce before minimizing');
  const protected1 = stackLines(SCRIPT, first.output, 'repro.js');
  assert.deepEqual(protected1, [6, 8]);

  const res = await minimizeCode({
    scriptText: SCRIPT,
    probe,
    scriptBasename: 'repro.js',
    initialStackLines: protected1,
    exec: inProcessCheck,
  });

  assert.equal(res.exhausted, false);
  assert.deepEqual(res.protectedLines, [6, 8]);
  const outLines = res.text.split('\n').length - (res.text.endsWith('\n') ? 1 : 0);
  assert.ok(outLines <= 7, `expected <= 7 lines, got ${outLines}:\n${res.text}`);
  assert.ok(res.text.includes("throw new Error('CODEMIN_MARK: ' + input.trim());"));
  assert.ok(!res.text.includes('deadA'), 'dead line survived minimization');
  // removing e.g. `function boom(input) {` alone yields invalid JS; those
  // candidates must be rejected by the syntax gate, never reach the oracle
  assert.ok(res.syntaxRejected >= 1, `expected syntax rejections, got ${res.syntaxRejected}`);
  for (const cand of seen) {
    assert.ok(validSyntax(cand), `oracle saw an invalid candidate:\n${cand}`);
  }
  // the minimized artifact was probed and reproduced (it is the last accepted state)
  assert.equal(verdicts.get(res.text), true, 'minimized text must have reproduced');
  assert.equal(await syntaxOk(res.text), true, 'minimized artifact must pass node --check');
});

test('minimizeCode honors maxProbes with an honest partial result', async () => {
  const probes = [];
  const probe = async (text) => { probes.push(text); return { reproduces: false }; };
  const res = await minimizeCode({
    scriptText: SCRIPT,
    probe,
    scriptBasename: 'repro.js',
    initialStackLines: [6, 8],
    maxProbes: 2,
    exec: inProcessCheck,
  });
  assert.equal(res.exhausted, true);
  assert.match(res.exhaustedReason, /probe budget exhausted/);
  assert.ok(probes.length <= 2, `gate must stop at the budget, saw ${probes.length} probes`);
  assert.ok(res.nextCandidates.length > 0);
  assert.ok(res.nextCandidates.every((c) => /^remove line \d+: /.test(c)));
});

test('syntaxOk accepts valid CJS and rejects broken candidates', async () => {
  assert.equal(await syntaxOk("const x = 1;\nmodule.exports = x;\n"), true);
  assert.equal(await syntaxOk('const x = ;\n'), false);
});

test('syntaxOk: ESM syntax is auto-detected by node --check on Node >= 22', async () => {
  const esm = "import { readFileSync } from 'node:fs';\nreadFileSync;\n";
  assert.equal(await syntaxOk(esm, { moduleType: 'module' }), true);
  // Node >= 22 module-syntax detection also accepts bare ESM syntax in
  // otherwise-ambiguous files (documented runtime behavior of `node --check`)
  assert.equal(await syntaxOk(esm, { moduleType: 'commonjs' }), true);
  assert.equal(await syntaxOk('import { from\n', { moduleType: 'module' }), false);
});
