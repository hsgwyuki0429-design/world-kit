#!/usr/bin/env node
/**
 * Architecture audit (§82, §83, §12).
 *
 * The dependency rules in §83 are the mechanism behind "SpatialWorld is the single source
 * of truth": if the game or the renderer can reach the tracker or the camera, they can
 * grow their own spatial state, and the guarantee is gone. An import-graph check makes the
 * rule enforceable rather than aspirational — including for phases not yet written, so the
 * constraint is in place before the code that would violate it exists.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// Optional argv[2] lets the audit be pointed at a fixture tree, so the audit itself can
// be tested rather than merely trusted.
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src');

/** layer -> layers it may not import from, with the reason. */
const FORBIDDEN = {
  game: {
    from: ['capture', 'pipeline', 'tracking', 'mapping'],
    why: 'the game layer must consume SpatialWorld only (§47, §83). Reaching the camera or ' +
      'the tracker would let it build spatial state of its own.',
  },
  renderer: {
    from: ['capture', 'pipeline', 'tracking', 'mapping'],
    why: 'the renderer must draw SpatialWorld, never generate geometry (§12, §40).',
  },
  world: {
    from: ['game', 'renderer', 'ui'],
    why: 'SpatialWorld is the source of truth and must not depend on its consumers.',
  },
  pipeline: {
    from: ['game', 'renderer', 'ui', 'world', 'tracking', 'mapping'],
    why: 'the frame pipeline feeds tracking and must not read back from it, from the world, ' +
      'or from the UI (§10, §83). A pipeline that could see the UI would be able to adapt ' +
      'to what is on screen rather than to what it measured.',
  },
  tracking: {
    from: ['game', 'renderer', 'ui', 'world'],
    why: 'tracking feeds mapping; a back-edge from world or the UI would invert the pipeline.',
  },
  mapping: {
    from: ['game', 'renderer', 'ui'],
    why: 'mapping writes to world; it must not read from its consumers.',
  },
  // Phase 5 adds this one, and it is the strictest rule in the table on purpose. The two-view
  // solvers are the stage under test in Phase 5, and GEO-003 scores them against outliers the
  // harness injected and never marked. A solver able to import from `tracking` could read the
  // population it is being asked to judge — including, once Phase 8 exists, whatever the
  // injector left behind. Pure math over the arrays it is handed, and nothing else.
  geometry: {
    from: ['game', 'renderer', 'ui', 'world', 'capture', 'pipeline', 'tracking', 'mapping', 'debug', 'testkit'],
    why: 'the geometry solvers are the stage Phase 5 tests. They take arrays and return ' +
      'models; reaching the tracker, the camera or the test kit would let a solver see the ' +
      'answer it is being scored against (§H.7, GEO-003).',
  },
};

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

const violations = [];
let checked = 0;

for (const [layer, rule] of Object.entries(FORBIDDEN)) {
  const files = walk(join(SRC, layer));
  for (const file of files) {
    checked++;
    const text = readFileSync(file, 'utf-8');
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      // Resolve "../tracking/Foo" style relative imports to their layer directory.
      const segments = spec.split('/').filter((s) => s !== '.' && s !== '..');
      const targetLayer = segments[0];
      if (rule.from.includes(targetLayer)) {
        violations.push({
          file: relative(ROOT, file),
          layer,
          target: targetLayer,
          spec,
          why: rule.why,
        });
      }
    }
  }
}

const note = `audit-architecture: checked ${checked} file(s) across ${Object.keys(FORBIDDEN).length} constrained layer(s)`;

if (violations.length === 0) {
  console.log(`${note} — 0 violations`);
  for (const [layer, rule] of Object.entries(FORBIDDEN)) {
    console.log(`  ok  ${layer.padEnd(9)} must not import: ${rule.from.join(', ')}`);
  }
  process.exit(0);
}

console.error(`${note} — ${violations.length} VIOLATION(S)\n`);
for (const v of violations) {
  console.error(`  ${v.file}  imports "${v.spec}" (layer: ${v.target})`);
  console.error(`    ${v.why}\n`);
}
process.exit(1);
