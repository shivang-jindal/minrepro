# minrepro — technical specification

> Companion to [`README.md`](./README.md). Build document: oracle abstraction,
> determinism harness, the minimization pipeline (input / code / environment),
> bisect integration, sandboxing, budgets, and honest-failure semantics.
> This is the hardest project in the vault; the spec is correspondingly strict.

---

## 1. Design invariants

1. **The oracle is sacred.** A transformation (removal, shrink, patch) is
   accepted only if the target failure signature still reproduces. Any
   uncertainty ⇒ reject the transformation. Every algorithm here is subordinate
   to that rule.
2. **Never claim more than we verified.** Output includes verification counts
   ("reproduced 10/10 runs") and confidence. A probabilistic tool that speaks
   in certainties is worse than no tool.
3. **Partial results are always shipped.** If we can't fully minimize, we
   still emit the smallest thing we achieved, plus what blocked us. The user's
   30 minutes must never end in a shrug.
4. **Bounded everything.** Every stage has a wall-clock and execution budget;
   minimization is a luxury, correctness of the *reported* result is not.
5. **Sandbox everything.** We execute code from arbitrary issue reports. It
   runs in a locked-down container with no network and no secrets — always,
   no exceptions, including for local runs.

## 2. CLI surface

```
minrepro <issue-url|pr-url|ci-url>     ingest a report
minrepro run --cmd "<test cmd>"        minimize a failure you can already trigger
  --repro <script>                     script that exits nonzero on failure
  --signature <file>                   explicit failure signature (else auto)

minrepro stages input|code|env|bisect  run only selected stages
minrepro post                          comment the result back on the issue
  --gist                               upload as gist + link
  --no-post                            dry run (default for untrusted repos)

minrepro verify <artifact-dir>         re-run the produced repro N times
minrepro attach --cmd "<cmd>"          CI mode: minimize a failing test in-place
minrepro config                        budgets, sandbox backend, model opt-in
```

Exit codes: `0` repro produced and verified · `1` partial (smallest achieved,
documented) · `2` usage · `3` could not reproduce at all · `4` unsupported
environment.

## 3. Core objects

```ts
type ReproSpec = {                     // from ingest
  repo: string; ref?: string;          // issue may name a version/commit
  steps: string[];                     // parsed repro steps
  stack?: Frame[];                     // parsed stack trace
  versions?: Record<string, string>;   // runtime/tool versions mentioned
  attachments: Asset[];                // logs, screenshots(→ignored), config
  harnessHint?: "test" | "script" | "repl";
};

type Oracle = {
  // deterministic predicate: does the target failure occur?
  probe(candidate: Candidate): Promise<ProbeResult>;
  signature: FailureSignature;
  confidence: number;                  // over repeated probes
};

type FailureSignature = {
  kind: "exit-code" | "exception" | "assertion" | "hang" | "signal" | "output-regex";
  normalized: string;   // exception class + top-K user frames, de-noised
                       // (paths → placeholders, line numbers dropped, ids hashed)
  raw?: string;
};

type Candidate = {
  repo: Repo;                           // checkout state
  input?: Input;                        // payload/env/config under test
  sourcePatch?: Patch;                  // AST-level removals applied
  env?: EnvSpec;
};
```

**Signature normalization is a product feature**, not an implementation detail:
paths, line numbers, UUIDs, timestamps, and hex ids are templated out so that a
minimized candidate still matches the *same* failure. Getting this wrong is the
#1 way minimizers silently produce garbage.

## 4. Pipeline

```
stage 0 ingest      issue/PR/CI → ReproSpec (+ optional manual overrides)
stage 1 provision   container per spec (or detected toolchain), pinned deps
stage 2 locate      produce an Oracle
                    a. replay scripted steps
                    b. match existing failing test (stack/keyword similarity)
                    c. synthesize probe harness (bisect-style runner)
stage 3 determinism harness on (§5) — repeated probes until confidence ≥ 0.95
                    or explicitly downgrade to "flaky" mode (§9)
stage 4 minimize input  (§6.1)
stage 5 minimize code   (§6.2)
stage 6 minimize env    (§6.3)
stage 7 bisect          minimized oracle → git bisect (§7)
stage 8 finalize        re-verify ×10 · render artifacts (§8)
```

Each stage is resumable; state in `.minrepro/state.json`. Stages 4–6 are
ordered big-bang→fine: each shrinks the *search space* of the next, and each
must independently re-verify against the oracle before accepting.

## 5. Determinism harness

Before minimizing anything, we must trust the oracle.

```
1. probe N=10 times, record outcomes
2. if 10/10 match → confidence 1.0, proceed
3. if mixed → apply stabilization, retest:
   - pin RNG (LD_PRELOAD shim / runtime seed flags)
   - freeze clock (libfaketime / time abstraction injection)
   - fix TZ, LANG, LC_ALL, thread counts (OMP_NUM_THREADS=1, etc.)
   - serialize schedulers where supported
4. still mixed → "flaky mode": accept a signature that reproduces ≥ 3/10,
   and SAY SO in the artifact (confidence badge in the report header)
5. never proceed below 3/10 — that's noise, not a bug
```

Optional (v2): `rr` record/replay for heisenbugs; report as an experimental
path since replay constrains later minimization.

## 6. Minimization

### 6.1 Input minimization

Two sub-strategies, chosen by input type:

**Structured inputs → property-style shrinking (preferred).** Represent the
input as a tree (arbitrary JSON/bytes → generic tree). Shrink operators:
drop element from list, replace number with smaller (0, 1, -1, halved), shorten
strings (bisect to empty), delete object keys, unwrap nested containers.
Queue-based, BFS-with-priority on (size, recency). This is the fast-check /
hypothesis approach: O(log n) probes instead of ddmin's O(n²) worst case.

**Unstructured / unknown-shape → ddmin.** Classic delta debugging over
byte/line granularity with an n-way split (start n=2, increase on failure,
decrease on progress). Use when the input is opaque (a binary blob, a compressed
payload).

Both cache probe results keyed by candidate hash — the same candidate is never
probed twice. Cache is the single biggest performance lever.

### 6.2 Code minimization (AST delta-debugging)

Goal: remove everything in the *reproducer* (the harness/repro script, or the
failing test itself) that isn't needed. We do **not** minimize the whole
codebase — that's `creduce`- territory and mostly unnecessary; the harness is
what's big.

```
1. parse harness with tree-sitter (per language)
2. candidate removals, coarse → fine:
   a. remove whole statements / imports
   b. remove arguments, object properties, decorators
   c. unwrap blocks, collapse conditionals (keep then-branch only)
   d. remove function bodies not on the failure's call path
3. for each candidate: apply removal → re-parse (must stay syntactically
   valid) → probe oracle → accept iff signature still matches
4. iterate to fixpoint or budget exhaustion
```

Safety rules:
- Never remove the statement(s) producing the signature.
- Dependency-aware ordering: removing a definition first cascades to its uses
  only after uses are proven removable (otherwise the candidate won't compile
  and we waste a probe).
- Compile errors are *rejected* candidates, not failures.

### 6.3 Environment minimization

- **Env vars:** delta-debug the set of non-essential vars (start from the
  full environment captured at provision; probe with progressively smaller
  subsets). Allowlist the harness-required ones (PATH, HOME, language roots).
- **Dependencies:** attempt removal of each direct dependency from the lock
  (or reduce to a minimal `requirements.txt`/`package.json`) via the same
  ddmin loop; install-time is bounded by a warm package cache.
- **Config files:** treat as structured input (§6.1) — shrink keys.
- **Runtime versions:** if the spec pins a runtime, try neighboring versions
  to detect version-sensitivity and report it (often the actual bug class).

## 7. Bisect

With a trusted minimized oracle:

```
1. resolve range: (issue-reported version) .. (default branch HEAD)
2. pre-filter: run oracle at both endpoints; if both fail, extend range;
   if neither fails, report "already fixed" (valuable outcome!)
3. standard bisection (~log2(n) probes), using the minimized harness
4. skip-uninteresting heuristics: docs-only commits short-circuit
5. optional: linarith-style interpolation for huge ranges
6. verify: check out the found commit, run oracle ×3
```

Bisect probes are the slowest part — parallelize where the oracle allows
(multiple containers), and let the budget cap it (partial range narrowing is
still useful output).

## 8. Artifacts

```
repro/
├─ repro.<lang>          the minimized reproduction (self-contained)
├─ Dockerfile            pinned environment
├─ run.sh                one command: build + run, exit code = bug present
├─ report.md             human report (below)
├─ state.json            machine state, resume info
└─ repro.json            structured: signature, confidence, steps, bisect result
```

`report.md` structure:

```markdown
# Reproduction: acme/sdk#4471
**Confidence:** 10/10 runs · deterministic ✅

## Minimal reproduction (20 lines, was ~1,200)
```ts …```

## What we removed
| Dimension | Before | After |
|-----------|--------|-------|
| payload   | 842 KB | 12 KB |
| harness   | 1,204 lines | 47 lines |
| env vars  | 41 | 2 |
| deps      | 38 | 6 |

## Culprit commit
`9c1f2ab "refactor: stream pipeline"` (2026-10-02) — verified at 3/3 probes
introduced-by range narrowed from 214 commits

## Run it
`docker build -t repro . && docker run --rm repro`  → exit 1
```

`minrepro post` renders this as an issue comment (collapsed details, no
external hosting unless `--gist`).

## 9. Honest failure modes

| Situation | Behavior |
|-----------|----------|
| Can't reproduce at all | emit `report.md` with everything tried + env diff vs. reporter's described env; exit 3 |
| Flaky (3–9/10) | proceed in flaky mode, badge the artifact, verify counts always shown |
| Budget exhausted mid-stage | ship current minimum, list the next-best candidates it didn't get to |
| Bisect inconclusive | report the narrowed range, not a false commit |
| Needs network to reproduce | report + optional `--allow-network` (never default) |
| Repo's own harness is broken | synthesize a probe harness; say so explicitly |

## 10. Sandbox spec

- Container backend: Docker/Podman today; Firecracker/Kata for the hosted tier.
- `--network=none` default; read-only rootfs; tmpfs workdir; non-root user;
  `--pids-limit`, memory + CPU caps; seccomp default; no host mounts.
- Credentials: never mounted. `GITHUB_TOKEN` only used by the *orchestrator*
  (outside the sandbox) for API calls.
- Timeouts: per-probe (default 120 s), per-stage, global. Kill = process group
  kill + container teardown.
- Reproducibility: images pinned by digest; toolchains installed from a warm
  content-addressed cache keyed by lockfile hash.

## 11. Performance budgets

| Phase | Budget | Notes |
|-------|--------|-------|
| provision (warm) | < 60 s | cached image |
| oracle calibration | ≤ 10 probes | early exit on 10/10 |
| input minimize | ≤ 300 probes | shrink-tree preferred; ddmin fallback |
| code minimize | ≤ 400 probes | coarse→fine ordering |
| env minimize | ≤ 150 probes | allowlist-first |
| bisect | ≤ 60 probes | partial narrowing accepted |
| total (typical) | 10–40 min | report actuals; run in background |

Every probe's duration is recorded; the report includes a cost summary —
useful for the user and for us to tune budgets.

## 12. Model assistance (opt-in, never required)

Uses:
1. **Step scripting** — turn prose repro steps into an executable script
   (fast win, low risk; output verified by the oracle like everything else).
2. **Shrink guidance** — prioritize candidate removals using stack/semantic
   hints (pure heuristic speedup; correctness still gated by the oracle).

Never: unverified patches, unverified claims, or sending repo code anywhere
except the user's configured endpoint.

## 13. Test strategy

1. **Seeded-bug fixtures.** For each minimization strategy, a fixture repo with
   a known bug and a known minimal form. Assert we reach the exact minimum (or
   within a documented bound), not just "something smaller."
2. **Oracle honesty tests.** Fixtures with nondeterministic failures assert
   flaky-mode behavior and badge output.
3. **Signature robustness tests.** Same bug with different paths/ids/line
   numbers must produce the same normalized signature.
4. **Budget tests.** Pathological fixtures (huge input, deep nesting) must
   exit with partial results on budget, never hang.
5. **Sandbox escape tests.** Fixtures that attempt host FS/network/process
   access must fail closed; run as a dedicated CI job.
6. **Real-world calibration (manual, pre-release).** Take 20 real
   `needs-repro`-labeled issues, run the pipeline, publish the success table —
   including failures. That table is the launch content and the honesty test.

## 14. v1 → v2 cut line

v1: one language (TS/Node), structured shrinking + ddmin on inputs, AST code
minimization for that language, env minimization, bisect, sandbox, artifacts,
`post` as a comment.

v2: Python/Go/Rust, microVM backend, record/replay, model-assisted step
scripting, `attach` CI mode, Linear/Jira integration, cross-language harness.
