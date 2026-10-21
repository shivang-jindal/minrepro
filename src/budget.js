// budget.js — bounded-everything accounting (SPEC §1.4, §11).
// A Budget is spent by probe stages; when exhausted, stages must stop and
// report the next candidates they did not get to (honest partial results).
// Only REAL executions cost budget — cache hits are free (SPEC §6.1: the
// cache is the single biggest performance lever).

export class Budget {
  /**
   * @param {number} maxProbes  hard cap on real oracle probes
   * @param {number} maxMs      wall-clock cap (0 = unlimited)
   */
  constructor(maxProbes = 300, maxMs = 0) {
    this.maxProbes = maxProbes;
    this.maxMs = maxMs;
    this.probes = 0;
    this.cacheHits = 0;
    this.started = Date.now();
    this.exhaustedReason = null;
  }

  /** Try to spend one probe BEFORE executing (uncached path). */
  trySpend() {
    if (this.probes >= this.maxProbes) {
      this.exhaustedReason = `probe budget exhausted (${this.maxProbes})`;
      return false;
    }
    if (this.maxMs > 0 && Date.now() - this.started >= this.maxMs) {
      this.exhaustedReason = `wall-clock budget exhausted (${this.maxMs} ms)`;
      return false;
    }
    this.probes += 1;
    return true;
  }

  /** Charge AFTER a probe: real executions cost, cache hits are free. */
  charge(cached) {
    if (cached) {
      this.cacheHits += 1;
      return;
    }
    this.probes += 1;
    if (this.probes >= this.maxProbes) {
      this.exhaustedReason = `probe budget exhausted (${this.maxProbes})`;
    }
  }

  get exhausted() {
    if (this.exhaustedReason === null && this.probes >= this.maxProbes) {
      this.exhaustedReason = `probe budget exhausted (${this.maxProbes})`;
    }
    return this.exhaustedReason !== null;
  }

  get remaining() { return Math.max(0, this.maxProbes - this.probes); }
}
