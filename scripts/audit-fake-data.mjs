#!/usr/bin/env node
/**
 * Anti-fake-data audit (§80, §59).
 *
 * §80 lists a set of things that, if any one of them is present, make a final PASS
 * impossible. Most of them are judgement calls, but a few have a mechanical signature,
 * and those are worth catching automatically on every run rather than by review:
 *
 *   - `Math.random()` anywhere in src/ — the spec bans it outright for spatial data, and
 *     a seeded Rng exists for the sampling that legitimately needs randomness.
 *   - `Date.now()` or elapsed time feeding a confidence or coverage value (§15, §16).
 *   - Hard-coded floor/wall/room geometry (§Rule 002).
 *
 * A grep cannot prove the absence of fake data. It can prove the absence of these
 * specific signatures, which is a real if narrow guarantee, and it makes the banned
 * pattern impossible to add by accident.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// Optional argv[2] lets the audit be pointed at a fixture tree, so the audit itself can
// be tested rather than merely trusted.
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src');

/** Each rule: a regex, why it is banned, and what to do instead. */
const RULES = [
  {
    id: 'MATH_RANDOM',
    pattern: /Math\s*\.\s*random\s*\(/g,
    spec: '§59, §80',
    why: 'Math.random() is banned in src/. Spatial data must never be generated, and ' +
      'sampling must be reproducible.',
    instead: 'use src/core/Rng.ts with an explicit seed',
  },
  {
    id: 'TIME_BASED_COVERAGE',
    pattern: /coverage\s*(\+=|=\s*[^;=]*\b(?:elapsed|Date\.now|performance\.now|setInterval)\b)/gi,
    spec: '§16, §38',
    why: 'coverage must change only when new spatial information is added, never with time',
    instead: 'derive coverage from occupied grid cells in SpatialWorld',
  },
  {
    id: 'TIME_BASED_CONFIDENCE',
    pattern: /confidence\s*(\+=|=\s*[^;=]*\b(?:elapsed|Date\.now|performance\.now|age)\b)/gi,
    spec: '§15, §31',
    why: 'confidence must come from observations and geometry, never from elapsed time',
    instead: 'compute from observationCount, reprojection error, parallax, stability',
  },
  {
    id: 'FIXED_GEOMETRY',
    pattern: /\b(?:FIXED_FLOOR|DEFAULT_FLOOR|FALLBACK_PLANE|DEFAULT_ROOM|MOCK_PLANE|FAKE_[A-Z_]+)\b/g,
    spec: 'Rule 002, §45',
    why: 'fixed floors, walls and room models are prohibited; collision may only reference ' +
      'reconstructed geometry',
    instead: 'read geometry from SpatialWorld, or report that none exists yet',
  },
];

/** Comment lines that quote a banned pattern while explaining the ban are not violations. */
function isExplanatoryContext(line) {
  const t = line.trim();
  const isComment = t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
  if (!isComment) return false;
  return /ban|forbid|prohibit|must never|never use|instead of|禁止/i.test(line);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|css)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const violations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      const line = lines[lineNo - 1] ?? '';
      if (isExplanatoryContext(line)) continue;
      violations.push({
        file: relative(ROOT, file),
        line: lineNo,
        rule: rule.id,
        spec: rule.spec,
        why: rule.why,
        instead: rule.instead,
        snippet: line.trim().slice(0, 120),
      });
    }
  }
}

const scannedNote = `audit-fake-data: scanned ${files.length} file(s) under src/`;

if (violations.length === 0) {
  console.log(`${scannedNote} — 0 violations`);
  for (const rule of RULES) console.log(`  ok  ${rule.id.padEnd(22)} (${rule.spec})`);
  process.exit(0);
}

console.error(`${scannedNote} — ${violations.length} VIOLATION(S)\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.rule}] (${v.spec})`);
  console.error(`    ${v.snippet}`);
  console.error(`    why: ${v.why}`);
  console.error(`    instead: ${v.instead}\n`);
}
process.exit(1);
