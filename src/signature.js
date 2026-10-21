// signature.js — failure-signature normalization (SPEC §3).
// The same bug must produce the same normalized signature regardless of
// absolute paths, line numbers, uuids, hex ids or timestamps. Getting this
// wrong is the #1 way minimizers silently produce garbage, so everything is
// templated to stable placeholders.

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const ISO_TIME_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const UNIX_MS_RE = /\b1[6-9]\d{11}\b|\b2\d{11}\b/g;
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s"':)\]]+/g;
const POSIX_PATH_RE = /\/(?:[\w.@+-]+\/)+[\w.@+-]+/g;
const BARE_FRAME_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/).*$/;

/**
 * Template volatile tokens out of a single line of output.
 * Order matters: paths first (they may contain hex-ish segments), then ids.
 */
export function normalizeText(line) {
  let s = String(line);
  s = s.replace(WIN_PATH_RE, '<PATH>');
  s = s.replace(POSIX_PATH_RE, '<PATH>');
  s = s.replace(UUID_RE, '<UUID>');
  s = s.replace(ISO_TIME_RE, '<TIME>');
  s = s.replace(UNIX_MS_RE, '<TIME>');
  s = s.replace(HEX_RE, '<HEX>');
  return s;
}

// Node stack frame: "    at fn (/abs/path/file.js:12:3)" or "    at /abs/file.js:12:3"
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;
// Node internal frames we do not treat as "user frames".
const INTERNAL_RE = /(?:^node:|^internal[\\/]|[\\/]node_modules[\\/])/;

/**
 * Parse Node-style stack frames from output text.
 * Returns user frames as { fn, file, basename, line, raw }.
 */
export function parseFrames(text) {
  const frames = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const [, fn, file, ln] = m;
    if (INTERNAL_RE.test(file)) continue;
    const basename = file.split(/[\\/]/).pop();
    frames.push({ fn: fn || '<anonymous>', file, basename, line: Number(ln), raw: line.trim() });
  }
  return frames;
}

/** Extract "ExceptionClass: message" from output.
 * Real Node uncaught-exception output starts with a `file:line` context
 * block before the error line, so scan for the first class-looking line
 * instead of insisting on the literal first non-empty line. */
export function parseErrorHead(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  // `Error` must be allowed bare: `TypeError` already matches via the
  // prefixed branch, but a plain `throw new Error(...)` head-lines to
  // `Error: msg` and would otherwise miss, dropping us into the
  // line-shift-sensitive exit-code branch.
  const ERR_RE = /^([A-Za-z_$][\w$]*(?:Error|Exception|Violation)|Error):\s*(.*)$/;
  for (const line of lines) {
    const m = ERR_RE.exec(line);
    if (m) return { cls: m[1], message: m[2] };
  }
  return { cls: null, message: lines[0] };
}

/**
 * Compute a normalized failure signature from a probe result.
 * @param {{code:number|null, signal:string|null, timedOut:boolean, stdout:string, stderr:string}} result
 * @param {{topK?:number, scriptBasename?:string}} opts
 * @returns {{kind:string, normalized:string, raw:string}}
 */
export function failureSignature(result, opts = {}) {
  const topK = opts.topK ?? 3;
  const raw = ((result.stderr || '') + '\n' + (result.stdout || '')).trim();
  const combined = raw;

  if (result.timedOut) {
    return { kind: 'hang', normalized: 'hang', raw: raw.slice(0, 500) };
  }
  if (result.signal) {
    return { kind: 'signal', normalized: `signal:${result.signal}`, raw: raw.slice(0, 500) };
  }
  const code = result.code ?? 1;
  const head = parseErrorHead(combined);
  const frames = parseFrames(combined);

  if (head && head.cls && frames.length > 0) {
    // exception signature: class + normalized message + top-K user frames
    const top = frames.slice(0, topK)
      .map((f) => `at ${f.fn} ${f.basename}`); // line numbers templated out
    const normalized = [
      `exception:${head.cls}`,
      normalizeText(head.message),
      ...top,
      `exit:${code}`,
    ].join('\n');
    return { kind: 'exception', normalized, raw: raw.slice(0, 500) };
  }

  // exit-code / bare output signature
  const firstLine = normalizeText((combined.split(/\r?\n/).find((l) => l.trim()) || '').trim());
  return {
    kind: 'exit-code',
    normalized: `exit:${code}\n${firstLine}`,
    raw: raw.slice(0, 500),
  };
}

/** Do two signatures describe the same failure? (kind + normalized) */
export function sameFailure(a, b) {
  return !!a && !!b && a.kind === b.kind && a.normalized === b.normalized;
}

/**
 * Is this frame pointing at the repro script itself (as opposed to a lib)?
 * Used by code minimization to protect the lines that produce the signature.
 */
export function isScriptFrame(frame, scriptBasename) {
  return frame.basename === scriptBasename;
}
