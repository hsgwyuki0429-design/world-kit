/**
 * The three cards every phase screen from 1 onward ends with, written once.
 *
 * **The chrome is Japanese; the engine's vocabulary is not.** The tester reads this screen while
 * holding the phone, so the words around a value are in the language they think in. The values
 * themselves are not translated — PASS, FAIL, PENDING, PASSED, TESTING, the record ids, the
 * capability and mode names — because those are what the evidence bundle, the exported filename,
 * the repository gate and every document in `docs/` are written in. A screen that said 合格 where
 * the bundle said PASS would make the two impossible to read against each other, which is the
 * one thing Rule 002 is about.
 *
 * `renderTests`, `renderEvidence` and `renderNavigation` were seven copies each, differing only
 * in a phase index, a couple of labels and which handler a button called. The markup below is
 * the markup they produced — same ids, same classes, same text, same em dashes — because the
 * automated legs press `#go-to-phase6`, read `#phase5-verdict`, and compare button labels
 * character for character. This is a move, not a redesign.
 *
 * **Phase 0 keeps its own two.** Its tests card lists `CAP-0001..CAP-00NN` with `Input` and
 * `Fail if` rows and no phase verdict head, and its evidence card carries the raw-JSON panel.
 * They are a different card that happens to share a name, and folding them in would have meant
 * a parameter that is ignored six times out of seven.
 */

import { Verdict } from '../core/types';
import { LOCKED_LABEL, NOT_IMPLEMENTED_LABEL } from '../core/controlLabels';
import type { PhaseInfo, TestResult } from '../core/types';
import { card, el } from './dom';

/**
 * The tests card: the phase's own verdict, the PASS/FAIL/PENDING tally, and every record.
 *
 * `index` only names the DOM id (`#phase5-verdict`), which the legs read to check the screen
 * and the engine agree. The verdict itself comes from `phase`, which the composition root got
 * from `PhaseRegistry` — the screen never computes one.
 */
export function testsSection(
  index: number,
  phase: PhaseInfo,
  results: readonly TestResult[],
): HTMLElement {
  if (results.length === 0) {
    // The reason is shown here too, empty though the card is, because one thing it can say is
    // that this phase's pass was carried over from an earlier page load — and the moment that
    // matters most is arrival, before anything has run and while the door ahead already looks
    // open for no visible reason.
    const children: (Node | string)[] = [el('p', { class: 'empty' }, ['まだ実行していません。'])];
    if (phase.reason) children.push(el('p', { class: 'verdict-reason' }, [phase.reason]));
    return card('テスト', children);
  }
  const counts = {
    pass: results.filter((r) => r.verdict === Verdict.PASS).length,
    fail: results.filter((r) => r.verdict === Verdict.FAIL).length,
    pending: results.filter((r) => r.verdict === Verdict.PENDING).length,
  };
  return card(`テスト — Phase ${index} · ${phase.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${phase.state}`, id: `phase${index}-verdict` }, [
        phase.state,
      ]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [phase.reason]),
    ...results.map((r) =>
      el('details', { class: 'row' }, [
        el('summary', {}, [
          el('span', { class: 'id' }, [r.spec.id]),
          el('span', { class: 'title' }, [r.spec.title]),
          el('span', { class: 'req' }, [r.spec.required ? '必須' : '参考']),
          el('span', { class: `verdict v-${r.verdict}` }, [r.verdict]),
        ]),
        el('dl', { class: 'detail-grid' }, [
          el('dt', {}, ['期待される結果']), el('dd', {}, [r.spec.expected]),
          el('dt', {}, ['合格条件']), el('dd', {}, [r.spec.passCriteria]),
          el('dt', {}, ['観測値']), el('dd', { class: 'mono' }, [r.observed]),
          el('dt', {}, ['理由']), el('dd', {}, [r.reason]),
        ]),
      ]),
    ),
  ]);
}

/**
 * The evidence card, and the warning that keeps an export honest.
 *
 * The download button's label carries the verdict, and a run with required records still
 * `PENDING` says so above it — §80: the bundle records what the run reached, and the control
 * that produces it must not read like a pass button.
 */
export function evidenceSection(
  index: number,
  phase: PhaseInfo,
  results: readonly TestResult[],
  handlers: { onDownload: () => void; onCopy: () => void },
): HTMLElement {
  const pending = results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: `phase${index}-pending-warning` }, [
        `この書き出しは ${phase.state} として記録されます。合格ではありません — ` +
          `${pending.map((r) => r.spec.id).join(', ')} がまだ PENDING です。`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: `download-evidence-p${index}`,
        textContent: `エビデンス JSON をダウンロード — ${phase.state}`,
        onclick: handlers.onDownload,
      } as never),
      el('button', {
        class: 'secondary',
        id: `copy-evidence-p${index}`,
        textContent: 'エビデンス JSON をコピー',
        onclick: handlers.onCopy,
      } as never),
    ]),
  );
  return card('エビデンス', children);
}

export interface NavigationBack {
  /** The phase this screen returns to — names the button id `#back-to-phaseN`. */
  readonly index: number;
  /** e.g. `BACK TO VERIFICATION`. Not derived from the phase name: the screens abbreviate. */
  readonly label: string;
  readonly onClick: () => void;
}

export interface NavigationNext {
  readonly index: number;
  /** The phase's display name in caps, e.g. `RELATIVE POSE`. Used by both refusal labels. */
  readonly name: string;
  /**
   * The label when the door is open, where it is not simply `${name}へ進む`.
   *
   * Phase 3's screen used to say `GO TO TRACKING` while its locked label said `OPTICAL FLOW
   * TRACKING` — one screen abbreviating where the others did not. The Japanese names are short
   * enough that it stopped needing to, so nothing overrides this today. The seam is kept for the
   * next screen whose name does not fit on a control.
   */
  readonly goLabel?: string;
  readonly phase: PhaseInfo;
  readonly canEnter: boolean;
  readonly implemented: boolean;
  readonly blockedReason: string;
  /**
   * Why an *open* door is open, when this session did not watch the predecessor pass —
   * `PhaseRegistry.lockNote`. Empty in the ordinary case, and empty while the door is shut,
   * which is `blockedReason`'s job.
   */
  readonly lockNote?: string;
  readonly onClick: () => void;
}

/**
 * The navigation card, and the Phase Lock stated on the control itself (Rule 002, Rule 005).
 *
 * Three states, and the difference between the last two is the point: a phase that has not been
 * written says so, and a phase that exists but whose predecessor has not passed says *that*,
 * with the registry's own reason underneath. A single greyed-out button would collapse them.
 */
export function navigationSection(back: NavigationBack, next: NavigationNext): HTMLElement {
  const open = next.canEnter && next.implemented;
  const label = !next.implemented
    ? `${next.name} — ${NOT_IMPLEMENTED_LABEL}`
    : !next.canEnter
      ? `${next.name} — ${LOCKED_LABEL}`
      : (next.goLabel ?? `${next.name}へ進む`);
  const note = !next.implemented
    ? `Phase ${next.index} はこのビルドには実装されていません。`
    : !next.canEnter
      ? next.blockedReason
      : `Phase ${next.index} は ${next.phase.state} です。`;
  const footnotes: HTMLElement[] = [el('p', { class: 'footnote' }, [note])];
  // Rule 002: an enterable button in front of a phase whose predecessor reads NOT_STARTED is
  // indistinguishable from a Phase Lock that has failed open, and the tester is told to stop
  // and report exactly that. So when the lock was opened by an earlier page load, the control
  // says so beside itself rather than leaving the screen to be read as a defect.
  if (open && next.lockNote) {
    footnotes.push(
      el('p', { class: 'footnote', id: `phase${next.index}-lock-note` }, [next.lockNote]),
    );
  }

  return card('ナビゲーション', [
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: `back-to-phase${back.index}`,
        textContent: back.label,
        onclick: back.onClick,
      } as never),
      el('button', {
        class: 'primary',
        id: `go-to-phase${next.index}`,
        disabled: !open,
        textContent: label,
        onclick: next.onClick,
      } as never),
    ]),
    ...footnotes,
  ]);
}
