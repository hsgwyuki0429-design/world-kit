/**
 * The three cards every phase screen from 1 onward ends with, written once.
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
    return card('Tests', [el('p', { class: 'empty' }, ['Not run yet.'])]);
  }
  const counts = {
    pass: results.filter((r) => r.verdict === Verdict.PASS).length,
    fail: results.filter((r) => r.verdict === Verdict.FAIL).length,
    pending: results.filter((r) => r.verdict === Verdict.PENDING).length,
  };
  return card(`Tests — Phase ${index} · ${phase.state}`, [
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
          el('span', { class: 'req' }, [r.spec.required ? 'REQ' : 'ADV']),
          el('span', { class: `verdict v-${r.verdict}` }, [r.verdict]),
        ]),
        el('dl', { class: 'detail-grid' }, [
          el('dt', {}, ['Expected']), el('dd', {}, [r.spec.expected]),
          el('dt', {}, ['Criteria']), el('dd', {}, [r.spec.passCriteria]),
          el('dt', {}, ['Observed']), el('dd', { class: 'mono' }, [r.observed]),
          el('dt', {}, ['Reason']), el('dd', {}, [r.reason]),
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
        `This export would record ${phase.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: `download-evidence-p${index}`,
        textContent: `DOWNLOAD EVIDENCE JSON — ${phase.state}`,
        onclick: handlers.onDownload,
      } as never),
      el('button', {
        class: 'secondary',
        id: `copy-evidence-p${index}`,
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopy,
      } as never),
    ]),
  );
  return card('Evidence', children);
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
   * The label when the door is open, where it is not simply `GO TO ${name}`.
   *
   * Phase 3's screen says `GO TO TRACKING` while its locked label says `OPTICAL FLOW TRACKING`.
   * That predates this module and is kept: the automated leg compares the label it finds against
   * the one it expects, so "tidying" it would fail a leg rather than a test.
   */
  readonly goLabel?: string;
  readonly phase: PhaseInfo;
  readonly canEnter: boolean;
  readonly implemented: boolean;
  readonly blockedReason: string;
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
    ? `${next.name} — NOT IMPLEMENTED`
    : !next.canEnter
      ? `${next.name} — LOCKED`
      : (next.goLabel ?? `GO TO ${next.name}`);
  const note = !next.implemented
    ? `Phase ${next.index} has not been written in this build.`
    : !next.canEnter
      ? next.blockedReason
      : `Phase ${next.index} is ${next.phase.state}.`;

  return card('Navigation', [
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
    el('p', { class: 'footnote' }, [note]),
  ]);
}
