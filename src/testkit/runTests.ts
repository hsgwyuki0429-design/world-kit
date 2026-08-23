/**
 * The shape every phase suite has, and the loop every one of them ran.
 *
 * Eight suites declared an identical `Evaluation`, an identical `PhaseNTest` differing only in
 * which context it takes, and a `runPhaseNTests` whose body was the same eight times over. The
 * loop below is that body, unchanged: it stamps `timestamp` at evaluation time and defaults
 * absent metrics to `{}`, exactly as each copy did.
 *
 * ## Why the suites keep their own named entry points
 *
 * `runPhase5Tests` still exists and still takes a `Phase5Context`. The generic function is not
 * exported to the composition root — each suite wraps it — because the context types are what
 * stop a screen from grading itself against the wrong phase's statistics, and a single
 * `runTests(PHASE5_TESTS, someOtherStats)` would type-check.
 *
 * ## What is deliberately not here
 *
 * `Phase2Tests`, `Phase3Tests` and `Phase4Tests` keep their own **unguarded** percentage
 * formatter, which prints `-50%` where the shared `pct` prints an em dash. The two look like the
 * same function and are not; unifying them would change what three passed phases print.
 */

import type { JsonValue, TestResult, TestSpec, Verdict } from '../core/types';

/** What a test record's `evaluate` returns, before the runner stamps it. */
export interface Evaluation {
  verdict: Verdict;
  observed: string;
  reason: string;
  metrics?: Record<string, JsonValue>;
}

/** One record: its spec, and the pure function that judges a run against it. */
export interface PhaseTest<Ctx> {
  spec: TestSpec;
  evaluate: (ctx: Ctx) => Evaluation;
}

/**
 * Run every record against one run's measurements.
 *
 * Nothing here decides anything: each record's own `evaluate` produces the verdict, and this
 * only carries it into a `TestResult`. That separation is why `PhaseRegistry.evaluate` can
 * re-derive a phase's state from committed evidence without re-running the suite — and why
 * `tests/unit/committedEvidence.test.ts` can check a bundle's verdict against its own results.
 */
export function runTests<Ctx>(tests: readonly PhaseTest<Ctx>[], ctx: Ctx): TestResult[] {
  return tests.map((test) => {
    const e = test.evaluate(ctx);
    return {
      spec: test.spec,
      verdict: e.verdict,
      observed: e.observed,
      reason: e.reason,
      metrics: e.metrics ?? {},
      timestamp: Date.now(),
    };
  });
}

/** `-1` means "not measured" throughout this codebase; every formatter prints it as an em dash. */
export function pct(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 10}%`;
}

export function deg(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100}°`;
}
