# minrepro — the "can't reproduce" killer

> **A 400-word bug report becomes a 20-line deterministic reproduction.**
> Maintainers ask for it in their issue template. Reporters run it in one command.

**Archetype:** CLI + GitHub App · **Buzz:** 🔥🔥🔥 · **Overpowered:** 💊💊💊💊💊 · **Difficulty:** Hard (this is the point)

---

## The problem

Open source runs on a broken handshake:

**Reporter:** "it crashes when I do X" (with 400 words, a partial log, three
screenshots, their OS, their Node version, and a config they forgot to mention).

**Maintainer:** "please provide a minimal reproduction."

Neither side is at fault. Minimal reproduction is *genuinely hard work* — it
requires understanding the system well enough to know which parts matter. It is
also the single highest-leverage artifact in the entire bug lifecycle:

- Without it: the issue sits for months, gets 3 "same here" comments, and is
  eventually closed by a stale bot. The bug ships forever.
- With it: fixed in hours, becomes a regression test, and the reporter feels
  seen.

The whole ecosystem has decided the correct answer is to *ask humans to do more
work*, twice, on both sides.

## The idea

```bash
$ minrepro https://github.com/acme/sdk/issues/4471
  ├─ ingest      repro steps + stack trace + versions parsed from issue
  ├─ provision   acme/sdk@main · container · node 22 · deps pinned
  ├─ locate      reproduced! ✅  test/http/upload.test.ts:88  "500 on large body"
  ├─ minimize
  │    inputs    842 KB → 12 KB payload (ddmin, 31 runs)
  │    code      1,204 → 47 lines (AST delta-debug, 61 runs)
  │    env       41 env vars → 2 · deps 38 → 6
  ├─ bisect      offending commit: 9c1f2ab (2 weeks ago) "refactor: stream pipeline"
  └─ output      repro.ts (20 lines) · Dockerfile · report.md

$ minrepro post
  → comment posted on #4471 with the repro attached + bisect result
```

The output is a **self-contained, deterministic, human-readable** reproduction:
one file, one command to run, green/red oracle, pinned environment, and the
commit that caused it. It pastes into the issue as a comment and drops straight
into the maintainer's test suite as a regression test.

## Why it's overpowered

- **It's the missing machine in the handshake.** Every other tool optimizes
  triage, labels, or duplicates. Nothing turns *unstructured human frustration*
  into *executable ground truth.* That's the actual bottleneck.
- **It's valuable to both sides simultaneously** — rare in developer tooling.
  Reporters get faster fixes; maintainers get clean queues.
- **It produces regression tests for free.** The minimized repro *is* the test.
  Maintainers who try it once never go back.
- **Deterministic reproduction is the hard part of AI-assisted debugging too.**
  This becomes infrastructure for the agent era, not a competitor to it.
- **It's genuinely hard, which is why it doesn't exist.** The difficulty *is*
  the moat. ddmin + tree-sitter + bisect + sandboxing + determinism is a real
  systems problem, and it's a fun one — great recruiting signal for contributors.

## Who wants it

- **Maintainers** of any project with >50 open issues (the target user).
- **Bug reporters** — even a partial success ("we shrank the payload 70×")
  makes their issue 5× more likely to get attention.
- **Companies** whose support teams file internal bug reports (huge, quiet
  willingness to pay).
- **CI systems** — auto-repro on every flaky/failing test.

## Features

**v0 (weekend):** one language (TypeScript/Node). Given a failing test command,
shrink the *inputs* using property-based shrinking (`fast-check`). Output a
single self-contained test file. That alone is a demo people want.

**v1:**
- GitHub App: `minrepro <issue-url>` parses the report, provisions the repo,
  and hunts for a matching failing test
- AST delta-debugging with `tree-sitter` to remove code that isn't needed
- environment minimization (env vars, deps, config files)
- `git bisect` integration using the minimized repro as the oracle
- deterministic harness: seeded RNG, frozen clock, fixed timezone/locale,
  single-threaded scheduler
- sandboxed execution: container, no network, resource caps

**v2:**
- multiple languages (Python, Go, Rust)
- microVM (Firecracker/Kata) isolation for fully untrusted reports
- nondeterminism handling: record/replay (`rr`), failure-signature clustering
  ("this flaky failure reproduces 3/10 runs; confidence reported honestly")
- `minrepro attach` for CI: auto-repro every flaky test failure in your own
  pipeline
- ecosystem integrations: attaches minimized repros to Jira/Linear/Zendesk

## Architecture

```
                    ┌─────────── ingest ───────────┐
 issue/PR/CI fail → │ NLP-lite parse · stack trace  │ → ReproSpec
                    │ version pins · env hints      │
                    └──────────────┬───────────────┘
                                   ▼
                        ┌── provision (container) ──┐
                        │ checkout @ sha · deps     │
                        │ determinism harness on    │
                        └──────────────┬────────────┘
                                       ▼
   ┌──────────────────── locate: find the oracle ───────────────────┐
   │ 1. replay issue steps directly (scripted)                      │
   │ 2. search existing tests by stack/keyword similarity           │
   │ 3. synthesize a probe harness (bisect-style)                   │
   └────────────────────────────┬───────────────────────────────────┘
                                ▼
              ┌─────────────── minimize (loop) ───────────────┐
              │ oracle = deterministic fail signature         │
              │  • input shrink   (ddmin / property shrink)   │
              │  • code shrink    (AST delta-debug, t-s)      │
              │  • env shrink     (vars, deps, config)        │
              │  each step verified against the SAME oracle   │
              └────────────────────┬──────────────────────────┘
                                   ▼
              ┌──── finalize ────┐   ┌──── report/post ────┐
              │ bisect w/ oracle │   │ repro + Dockerfile  │
              │ final verify ×N  │   │ issue comment / gist│
              └──────────────────┘   └─────────────────────┘
```

Three ideas carry the whole thing:

1. **The oracle is sacred.** Minimization only removes something if the failure
   signature still matches after removal. Everything else is bookkeeping.
2. **Hierarchical shrinking.** Big structured inputs shrink structurally (arrays,
   then objects, then strings) *before* byte-level ddmin — orders of magnitude
   fewer executions.
3. **Determinism is a first-class stage, not an afterthought.** The harness pins
   RNG, clock, locale, TZ, and scheduler before the first minimization run. A
   non-deterministic oracle makes all of this impossible.

## Growth loop

1. **The App posts a minimized repro on a real issue.** Every maintainer who
   receives one becomes an advocate — and links to it in their issue template
   ("run `npx minrepro` before filing"). That's your install loop, from inside.
2. **Issue-template ubiquity.** One line in a YAML template becomes the
   distribution channel across thousands of repos.
3. **"We reproduced 312 issues this month"** weekly dashboard → inherently
   shareable stats.
4. **Ecosystem reports:** "the most-unreproducible bugs in open source" —
   deterministic, interesting, link-magnet.

## Competitors & wedge

| Existing | Gap you exploit |
|----------|-----------------|
| `creduce` / `halfempty` / `picire` | C/parse-tree focused; no issue ingestion, no git, no determinism |
| Property-based shrinking | Only for property tests; requires the reporter to have written one |
| `rr` / record-replay | Captures nondeterminism, doesn't minimize or integrate with issues |
| LLM "repro this for me" demos | No determinism, no minimization guarantees, no sandboxing |

**Wedge:** end-to-end (issue URL → posted repro), deterministic, and it knows
when to *report honest failure* with partial results.

## 48-hour MVP

1. **Day 1 AM:** input shrinking for a failing test in a Node repo. Wire
   `fast-check` as a harness wrapper: given a failing property, print the
   shrunk input.
2. **Day 1 PM:** run it on 3 real issues from popular repos that have
   "needs repro" labels. Save the outputs.
3. **Day 2 AM:** write the report generator: single-file repro + before/after
   table + bisect result (manual bisect is fine for the demo).
4. **Day 2 PM:** post the three minimized repros as comments on those issues.
   The maintainer replies *are* your validation, and they double as testimonials.

## Monetization (open core)

- Free: CLI, self-hosted, one language, forever.
- **Maintainer tier:** hosted App, private repos, queue dashboard, integration
  with Linear/Jira, higher concurrency.
- **Enterprise/Support:** microVM isolation, on-prem corpus, SLA, support-ticket
  ingestion, compliance (SOC2-ready reporting).

## Risks

- **Nondeterministic bugs.** Report reproduction *confidence* honestly; support
  record/replay; never fake certainty.
- **Timeouts and cost.** Every minimization run is bounded; budgets per issue;
  partial results are always valuable, ship them.
- **Executing untrusted code.** The most dangerous part: sandbox everything,
  no network, drop privileges, consider microVMs for the hosted tier.
- **False attribution (bisect blames the wrong commit).** Always verify the
  final minimized repro at both bisect endpoints before claiming.

## Build & test

Zero runtime dependencies - Node >= 20 only. No `npm install`, no lockfile.

Note: the suite performs ~140 **real** child-process probes (that is the
product's own execution model, not test overhead), so on hosts with aggressive
AV scanning `node --test test/` takes a few minutes. Keep it green, don't
trim it.

```bash
# run from the minrepro directory
node src/cli.js --help
node src/cli.js run --repro repro.js --input input.json   # oracle -> shrink -> verify xN -> repro/
node src/cli.js verify repro/ -n 5                        # replay the artifact ×5 (real runs, probe-cache bypass)
node src/cli.js bisect --repo <git-dir> --oracle repro/ --range v1..HEAD
node --test test/                                         # 97 tests
```

## v0 status

**Shipped, covered by 97 passing tests:**

- **Run pipeline**: oracle calibration (N probes classify the bug
  deterministic / flaky / could-not-reproduce) -> input shrinking (structured
  JSON walker with a deduped probe cache; line-level ddmin for everything
  else) -> code minimization (dead-line removal, stack-cited lines protected,
  every candidate syntax-checked before it is probed) -> env minimization
  (noise vars removed against an allowlist) -> final verify xN with cache
  bypass, so a flaky oracle can never launder a cached pass into "verified"
- **Signatures**: a normalized failure identity - absolute paths, line
  numbers, UUIDs/hex/timestamps templated out; the exit code participates;
  a flaky oracle surfaces as distinct signatures rather than a fake match
- **Artifacts**: `repro/` with `report.md` (before/after tables, per-stage
  accept/reject log, budget notes, confidence badge), `repro.json` (machine
  schema including the minimized env), the minimized input and script, and
  run scripts; `minrepro verify` replays the artifact including the recorded env
- **Honest artifacts**: no timestamps anywhere in the artifact set (two
  identical runs are byte-identical); `verify` on an incomplete artifact dir
  is a usage error, not "could not reproduce"; artifacts that keep env values
  say so loudly (repro/ is sensitive when the launch env held credentials)
- **`--report-format md|json`**: md (default) keeps the human `report.md`;
  json writes a byte-deterministic `report.json` (`{title, signature,
  stages:[{name, before, after, accepted}], confidence, exitCode}`) and keeps
  `report.md` OFF
- **Bisect**: walks a real git range with the minimized oracle, re-verifies
  the culprit N times, checks both endpoints (never blames the wrong commit),
  and detects the "already fixed" case honestly
- **Budgets**: per-stage probe budgets with honest partial results (exit 1,
  smallest achieved, next candidates) - never a silent truncation
- **Execution hygiene**: clean-env probes, temp working dirs, per-probe
  timeout with process-tree kill, capped output
- **Exit codes**: 0 verified / 1 partial (documented in report.md) / 2 usage
  / 3 could-not-reproduce
- **Tests**: signature normalization (paths/lines/UUIDs/timestamps), exact-
  minimum JSON shrink with probe-count assertions, ddmin line sets,
  stack-protected code shrink, env allowlists, oracle calibration + flaky +
  timeout paths, an end-to-end pipeline artifact check, bisect over
  throwaway git repos (with real-probe-count assertions), verify-is-N-real-
  runs regression, exec hygiene, budgets, and CLI exit codes

**Deferred (v1+, per SPEC section 14):** `minrepro post` (publishing the repro
as a GitHub issue comment), languages beyond JS/TS/Node, model-assisted step
scripting, and record/replay. v2: Python/Go/Rust harnesses, microVM
sandboxing, `attach` CI mode, Linear/Jira integration.
