// util.js — small shared helpers (zero-dependency).
import { createHash } from 'node:crypto';

/** Stable content hash used for probe caching. */
export function hash(...parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(typeof p === 'string' ? p : JSON.stringify(p));
    h.update('\u0000');
  }
  return h.digest('hex');
}

/** Byte length of a string (UTF-8), for before/after tables. */
export function byteSize(s) {
  return Buffer.byteLength(s, 'utf8');
}

/** Human-ish byte size for reports: "842 B" / "12.1 KB". */
export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Split text into lines, preserving no trailing-newline semantics. */
export function splitLines(text) {
  return text.split(/\r?\n/);
}

/** Join lines back with \n (Windows-safe: we normalize on write). */
export function joinLines(lines) {
  return lines.join('\n');
}

/** Tiny logger that respects --quiet / injected sink. */
export function makeLogger(sink = (s) => process.stdout.write(s + '\n'), quiet = false) {
  return {
    info(msg) { if (!quiet) sink(msg); },
    always(msg) { sink(msg); },
  };
}
