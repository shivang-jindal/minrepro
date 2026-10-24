// Test bootstrap.
//
// Node >= 21 treats positional `--test` arguments as GLOB PATTERNS, so
// `node --test test/` matches the DIRECTORY `test` itself and executes it as a
// single entry (`node <dir>`, resolved here as index.js). This file therefore
// loads every test module explicitly so the mandated `npm test` command stays
// green on Node 24.
//
// In all other contexts (bare `node --test`, explicit file globs such as
// `node --test test/*.test.js`, Node 20 directory search) each *.test.js runs
// on its own and this file is either not executed or intentionally inert — no
// test ever runs twice.
//
// House style: same guard as oss-ideas/issue-radar/test/index.js.

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const invokedDirectly = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
);

if (!invokedDirectly) {
  await import('./signature.test.js');
  await import('./shrink-json.test.js');
  await import('./ddmin.test.js');
  await import('./code-min.test.js');
  await import('./env-min.test.js');
  await import('./oracle.test.js');
  await import('./exec.test.js');
  await import('./util.test.js');
  await import('./budget.test.js');
  await import('./artifacts.test.js');
  await import('./module-type.test.js');
  await import('./bisect.test.js');
  await import('./pipeline.test.js');
  await import('./report-format.test.js');
  await import('./verify.test.js');
  await import('./cli.test.js');
}
