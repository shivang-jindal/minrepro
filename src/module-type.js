// module-type.js — detect whether a .js script is ESM or CommonJS by walking
// up to the nearest package.json "type". Scratch dirs and artifact dirs get a
// mirror of that type so `node --check` and runtime behave like the original.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** @returns {'module'|'commonjs'} */
export function moduleTypeFor(scriptPath) {
  let dir = dirname(scriptPath);
  for (let i = 0; i < 40; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const t = JSON.parse(readFileSync(pkg, 'utf8')).type;
        if (t === 'module') return 'module';
        return 'commonjs';
      } catch {
        return 'commonjs';
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'commonjs';
}

/** Write a package.json declaring `type` into `dir` (no-op for commonjs on
 *  Windows-safe scratch dirs we still write it for clarity). */
export function mirrorModuleType(dir, type) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type }), 'utf8');
}
