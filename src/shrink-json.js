// shrink-json.js — structured input minimization (SPEC §6.1).
// Property-style shrinking over the JSON tree with a size-priority queue:
// drop array elements, shrink numbers toward 0/1/-1/halved, bisect strings
// to empty, delete object keys, unwrap single-element containers.
// Probe results are cached by the oracle (keyed on candidate hash).
import { Budget } from './budget.js';
import { humanBytes } from './util.js';

function jsonSize(value) {
  return JSON.stringify(value)?.length ?? 0;
}

/** Numbers shrink toward 0, 1, -1 and halved (SPEC §6.1). */
export function* shrinkNumber(n) {
  const cands = [];
  if (n !== 0) cands.push(0);
  if (n !== 1 && n !== 0) cands.push(1);
  if (n !== -1 && n !== 0) cands.push(-1);
  if (Number.isFinite(n) && Math.abs(n) > 1) cands.push(Math.trunc(n / 2));
  for (const c of cands) if (c !== n) yield c;
}

/** Strings bisect toward empty (SPEC §6.1). */
export function* shrinkString(s) {
  if (s.length === 0) return;
  yield '';
  const mid = Math.floor(s.length / 2);
  if (mid > 0) yield s.slice(0, mid);
  if (s.length - mid > 0 && mid !== s.length - mid) yield s.slice(mid);
}

/** All direct shrink candidates of a JSON value. */
export function* shrinkValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 1) yield value[0]; // unwrap single-element container
    if (value.length > 1) {
      // drop chunks (halves first, then every element)
      yield value.slice(0, Math.floor(value.length / 2));
      yield value.slice(Math.floor(value.length / 2));
      for (let i = 0; i < value.length; i++) {
        yield value.filter((_, j) => j !== i);
      }
      // shrink elements in place (front-to-back; queue re-prioritizes)
      for (let i = 0; i < value.length; i++) {
        for (const s of shrinkValue(value[i])) {
          const copy = value.slice();
          copy[i] = s;
          yield copy;
        }
      }
    }
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1) yield value[keys[0]]; // unwrap single-key container
    for (const k of keys) {
      const copy = { ...value };
      delete copy[k];
      yield copy;
    }
    for (const k of keys) {
      for (const s of shrinkValue(value[k])) {
        yield { ...value, [k]: s };
      }
    }
  } else if (typeof value === 'number') {
    yield* shrinkNumber(value);
  } else if (typeof value === 'string') {
    yield* shrinkString(value);
  } else if (value === true) {
    yield false;
  }
  // false, null have no smaller form
}

/**
 * Minimize a JSON input against the oracle.
 * @param {object} opts
 * @param {any} opts.value            parsed JSON value
 * @param {(candidate:any)=>Promise<{reproduces:boolean}>} opts.probe
 * @param {number} [opts.maxProbes]
 * @param {object} [opts.log]
 * @returns {Promise<{value:any, exhausted:boolean, exhaustedReason:string|null,
 *   probesAccepted:number, probesRejected:number, nextCandidates:string[]}>}
 */
export async function minimizeJson({ value, probe, maxProbes = 300, log }) {
  const budget = new Budget(maxProbes);
  let best = value;
  let accepted = 0;
  let rejected = 0;
  const nextCandidates = [];
  const seen = new Set([JSON.stringify(best)]);
  // priority queue: smaller serialized size first, then insertion order (recency)
  const queue = [];
  let seq = 0;
  const push = (v) => {
    const key = JSON.stringify(v);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ v, size: jsonSize(v), seq: seq++ });
  };
  for (const c of shrinkValue(best)) push(c);

  while (queue.length > 0) {
    if (budget.exhausted) {
      // honest partial: list what we did not get to (SPEC §9)
      queue.sort((a, b) => a.size - b.size || a.seq - b.seq);
      for (const item of queue.slice(0, 10)) {
        nextCandidates.push(JSON.stringify(item.v).slice(0, 200));
      }
      log?.info?.(`[input] budget exhausted with ${queue.length} candidates pending`);
      return {
        value: best, exhausted: true, exhaustedReason: budget.exhaustedReason,
        probesAccepted: accepted, probesRejected: rejected, nextCandidates,
      };
    }
    queue.sort((a, b) => a.size - b.size || a.seq - b.seq);
    const { v } = queue.shift();
    const { reproduces, cached } = await probe(v);
    budget.charge(!!cached); // cache hits are free
    // A candidate is an improvement only if it STILL REPRODUCES and is
    // strictly smaller — without the size guard, later (larger) candidates
    // in the queue would regrow the result with freshly-probed noise.
    if (reproduces && jsonSize(v) < jsonSize(best)) {
      best = v;
      accepted += 1;
      log?.info?.(`[input] ${jsonSize(value)} -> ${jsonSize(v)} chars (${humanBytes(jsonSize(v))})`);
      for (const c of shrinkValue(v)) push(c);
    } else {
      rejected += 1;
    }
  }
  return {
    value: best, exhausted: false, exhaustedReason: null,
    probesAccepted: accepted, probesRejected: rejected, nextCandidates: [],
  };
}
