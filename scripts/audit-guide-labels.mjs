#!/usr/bin/env node
/**
 * Every on-screen label a device guide quotes must still be on the screen.
 *
 * The guides are the tester's instrument. They say things like *"if **端末 → カメラ** stays
 * refused, stop and report it"*, and a tester on a phone can only follow that while the phone
 * shows those words. On 2026-09-21 the interface was translated and the guides were not: 169
 * references across eleven guides still named the English labels the screens had until that
 * morning — including four *"stop and report it"* checks, whose condition could no longer be
 * read off the device at all.
 *
 * That is the same failure as CAP-0011's, aimed at the human rather than the grader: a check
 * written against a word nobody displays any more. `src/core/controlLabels.ts` fixed it for the
 * one label a test greps; this fixes it for the ones a person reads.
 *
 * ## What it checks, and why only this
 *
 * Every Japanese-containing span — `` `…` ``, `*…*`, `**…**` — in a device guide must appear as
 * a label literal in `src/ui/`. Japanese spans are there because someone put a label in them,
 * so the rule has no false positives, and it catches the drift that will actually happen next:
 * a label is reworded in a screen and the guide keeps quoting the old wording.
 *
 * It deliberately does **not** try to judge English spans. The guides emphasise ordinary prose
 * — *"Check they land on things."* — and a rule that guessed which of those were labels would
 * be wrong often enough to be turned off. English that names a label is caught by this rule's
 * counterpart in review: an English label in a Japanese interface is itself the defect.
 *
 * Optional argv[2] and argv[3] point the audit at fixture trees, so it can be tested rather
 * than trusted — the arrangement `audit-fake-data.mjs` and `audit-architecture.mjs` use.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const UI = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src/ui');
const DOCS = process.argv[3] ? resolve(process.argv[3]) : join(ROOT, 'docs');

function walk(dir, match) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(entry)) out.push(full);
  }
  return out;
}

const HAS_JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;

/**
 * Everything the interface can put on the screen, in the two forms it exists in the source.
 *
 * `literals` are the quoted strings — labels, captions, button text. `suffixes` are the static
 * tails of template literals, which is how the navigation is built: the "go" control reads
 * `${next.name}へ進む`, so `へ進む` is a suffix and `特徴点検出` is a literal, and neither on its
 * own is the label a guide quotes.
 */
function uiVocabulary() {
  const text = walk(UI, (f) => f.endsWith('.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const literals = new Set();
  for (const m of text.matchAll(/'([^'\n]{1,80})'/g)) literals.add(m[1]);
  const suffixes = new Set();
  for (const m of text.matchAll(/\}([^`$\n]{1,20})`/g)) if (HAS_JAPANESE.test(m[1])) suffixes.add(m[1]);
  return { text, literals, suffixes };
}

/**
 * Whether the phone can show this span.
 *
 * Three ways it can, and the two beyond "the source contains it" are both real labels a guide
 * has to be able to quote: one built from a phase name and a fixed tail, and one built from a
 * fixed head and a value — `エビデンス JSON をダウンロード — PASSED` names the verdict it is
 * about to write, which is the whole point of that control.
 */
function displayable(span, ui) {
  if (ui.text.includes(span)) return true;
  for (const suffix of ui.suffixes) {
    if (span.endsWith(suffix) && ui.literals.has(span.slice(0, -suffix.length))) return true;
  }
  for (const literal of ui.literals) {
    if (literal.length >= 4 && span.startsWith(literal)) return true;
  }
  return false;
}

const ui = uiVocabulary();
const guides = walk(DOCS, (f) => f === 'HOW-TO-RUN-DEVICE-TEST.md');
const violations = [];
let checked = 0;

for (const file of guides) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const spans = line.matchAll(/`([^`\n]{2,60})`|\*\*([^*\n]{2,60})\*\*|(?<!\*)\*([^*\n]{2,60})\*(?!\*)/g);
    for (const m of spans) {
      const span = (m[1] ?? m[2] ?? m[3]).trim();
      if (!HAS_JAPANESE.test(span)) continue;
      // `…` marks a shape rather than a label — the guides write `… へ進む` where a phase's own
      // name goes — and a span carrying code spans inside it is a sentence whose labels are
      // checked as those code spans.
      if (span.includes('…') || span.includes('`')) continue;
      checked++;
      if (displayable(span, ui)) continue;
      violations.push({ file: relative(ROOT, file), line: i + 1, span, text: line.trim() });
    }
  });
}

const note = `audit-guide-labels: ${checked} label reference(s) across ${guides.length} device guide(s)`;

if (violations.length === 0) {
  console.log(`${note} — all present in src/ui`);
  process.exit(0);
}

console.error(`${note} — ${violations.length} NOT ON ANY SCREEN\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${JSON.stringify(v.span)}`);
  console.error(`    ${v.text.slice(0, 120)}`);
  console.error(
    '    why: a tester cannot follow an instruction about words the phone does not show.\n' +
      '    fix: quote the label as src/ui renders it now, or restore the wording in the screen.\n',
  );
}
process.exit(1);
