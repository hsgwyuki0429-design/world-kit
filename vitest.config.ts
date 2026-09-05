import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    /*
     * Vitest's default is 5 s, and this suite outgrew it — silently, in the one place where a
     * red build costs the most.
     *
     * These are not unit tests in the millisecond sense. Several of them run the real solvers
     * over hundreds of synthetic frames because that is the only way to measure what they
     * claim: `verification.test.ts`'s injection-floor test runs 42 seeded RANSAC fits, half of
     * them deliberately on sets too small to converge, and `poseStage.test.ts` drives whole
     * gyroscope sequences. On a developer machine they finish in 3.2–4.7 s. A GitHub runner is
     * roughly 1.4x slower, which puts the same tests at 4.5–6.9 s — one side of 5 s locally and
     * the other side of it in CI.
     *
     * That is exactly what happened: the injection-floor test timed out at 5000 ms on the
     * runner on 2026-08-29, `npm test` failed, and because the Pages deploy runs `npm test`
     * before building, **the deploy stopped at the previous commit**. The device kept loading
     * the build from before the Phase 5 instrument corrections and kept failing GEO-002 and
     * GEO-003 on the instruments those corrections had already fixed. The gyroscope test was
     * 516 ms from being the next one.
     *
     * 30 s, so the margin is a factor of four rather than a coin toss, and a genuine hang still
     * fails rather than hanging the job.
     */
    testTimeout: 30_000,
  },
});
