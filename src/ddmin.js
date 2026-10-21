// ddmin.js — line-granularity delta debugging for unstructured text inputs
// (SPEC §6.1 fallback). Classic n-way split: start n=2, test complements,
// decrease granularity on progress, increase on failure. Returns the
// smallest line set that still reproduces, plus honest budget reporting.
import { Budget } from './budget.js';

/**
 * Minimize text by removing lines.
 * @param {object} opts
 * @param {string} opts.text
 * @param {(candidateText:string)=>Promise<{reproduces:boolean}>} opts.probe
 * @param {number} [opts.maxProbes]
 * @param {object} [opts.log]
 * @param {number[]} [opts.protect] line indexes (0-based) that must never be
 *        removed (e.g. the line producing the failure signature)
 * @returns {Promise<{text:string, keptLines:number[], exhausted:boolean,
 *   exhaustedReason:string|null, probesAccepted:number, probesRejected:number,
 *   nextCandidates:string[]}>}
 */
export async function ddminLines({ text, probe, maxProbes = 300, log, protect = [] }) {
  const budget = new Budget(maxProbes);
  const lines = text.split(/\r?\n/);
  const protectedSet = new Set(protect);
  let kept = lines.map((_, i) => i); // indexes of kept lines
  let accepted = 0;
  let rejected = 0;
  const nextCandidates = [];

  const render = (idx) => idx.map((i) => lines[i]).join('\n');

  // test removing a set of indexes; protected lines are never removed
  const tryRemove = async (toRemove) => {
    if (budget.exhausted) return false;
    const remove = toRemove.filter((i) => !protectedSet.has(i));
    if (remove.length === 0) return false;
    const removeSet = new Set(remove);
    const candidate = kept.filter((i) => !removeSet.has(i));
    const { reproduces, cached } = await probe(render(candidate));
    budget.charge(!!cached); // cache hits are free
    if (reproduces) {
      kept = candidate;
      accepted += remove.length;
      log?.info?.(`[text] removed ${remove.length} line(s); ${kept.length} kept`);
      return true;
    }
    rejected += remove.length;
    return false;
  };

  let granularity = 2;
  while (kept.length >= 1) {
    if (budget.exhausted) {
      // report next-best: removing each remaining removable line individually
      for (const i of kept.filter((k) => !protectedSet.has(k)).slice(0, 10)) {
        nextCandidates.push(`remove line ${i + 1}: ${JSON.stringify(lines[i].slice(0, 120))}`);
      }
      log?.info?.(`[text] budget exhausted: ${budget.exhaustedReason}`);
      return {
        text: render(kept), keptLines: kept, exhausted: true,
        exhaustedReason: budget.exhaustedReason, probesAccepted: accepted,
        probesRejected: rejected, nextCandidates,
      };
    }
    const chunks = split(kept, granularity);
    let reduced = false;
    // complements first (SPEC §6.1: n-way split, test complement of each chunk)
    for (const chunk of chunks) {
      const complement = kept.filter((i) => !chunk.includes(i));
      if (complement.length === kept.length) continue;
      const removeSet = new Set(kept.filter((i) => !complement.includes(i)));
      if (await tryRemove([...removeSet])) { reduced = true; break; }
    }
    if (reduced) {
      granularity = Math.max(granularity - 1, 2);
      continue;
    }
    // then test each chunk alone (keep only the chunk)
    for (const chunk of chunks) {
      if (chunk.length >= kept.length) continue;
      if (await tryRemove(kept.filter((i) => !chunk.includes(i)))) {
        // tryRemove already narrowed `kept` to the chunk (plus protected lines)
        reduced = true;
        break;
      }
    }
    if (reduced) {
      granularity = Math.max(granularity - 1, 2);
      continue;
    }
    if (granularity >= kept.length) break;
    granularity = Math.min(kept.length, granularity * 2);
  }
  if (budget.exhausted) {
    // budget blew during the final granularity passes — report honestly
    for (const i of kept.filter((k) => !protectedSet.has(k)).slice(0, 10)) {
      nextCandidates.push(`remove line ${i + 1}: ${JSON.stringify(lines[i].slice(0, 120))}`);
    }
    return {
      text: render(kept), keptLines: kept, exhausted: true,
      exhaustedReason: budget.exhaustedReason, probesAccepted: accepted,
      probesRejected: rejected, nextCandidates,
    };
  }
  return {
    text: render(kept), keptLines: kept, exhausted: false, exhaustedReason: null,
    probesAccepted: accepted, probesRejected: rejected, nextCandidates: [],
  };
}

function split(arr, n) {
  if (n <= 1) return [arr.slice()];
  const size = Math.ceil(arr.length / n);
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
