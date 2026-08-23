/**
 * The three summarising helpers every phase session was carrying a copy of.
 *
 * `FlowSession`, `VerificationSession`, `PoseSession` and `FusionSession` each had a
 * byte-identical `median` and `round`, and a `trim` that differed only in whether its parameter
 * was typed `number[]` or `unknown[]`. Every body below is the copy that was already there.
 *
 * They live in `core` rather than in `tracking` because they are arithmetic with no knowledge of
 * a frame, a feature or a pose — and because `core` is the one layer everything may import, so
 * a later phase's session can use them without the architecture audit having to grow a rule.
 *
 * ## Why `-1` and not `null`
 *
 * `median` returns `-1` for an empty set, which is the convention this codebase uses everywhere
 * for "not measured": every formatter prints `-1` as an em dash, every test record treats it as
 * absent rather than as a value, and §80 turns on the difference between an unmeasured quantity
 * and a measured zero. A `null` would have to be handled at every call site or silently coerced
 * to 0 by arithmetic — which is exactly the fabrication the convention exists to prevent.
 */

/** The middle value, or the mean of the middle two. `-1` where there is nothing to summarise. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

/**
 * Round for reporting. Non-finite values pass through unchanged rather than becoming `NaN`.
 *
 * Three decimals by default: enough to see a sub-pixel residual move, few enough that an
 * evidence bundle does not carry seventeen digits of floating-point noise as if they meant
 * something.
 */
export function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}

/**
 * §56's retained-sample bound, shared because all four sessions had chosen the same number.
 *
 * 400 samples at the rates these run is a few tens of seconds of history — long enough for a
 * median to describe the run rather than the last second, short enough that a twenty-minute
 * session cannot grow the arrays without limit.
 */
export const MAX_SAMPLES = 400;

/**
 * §56's bound, applied in place: drop from the front until the window fits.
 *
 * A twenty-minute session must not grow a sample array without limit. Dropping the *oldest* is
 * what makes the retained window describe recent behaviour — and Phase 6's device run is the
 * reason this matters: a bounded window beside an unbounded counter produced an agreement rate
 * of 232.3%, because the numerator kept climbing over a frozen denominator. Whatever a figure
 * is derived from has to be trimmed by the same call that trims what it is divided by.
 */
export function trim(list: unknown[], max = MAX_SAMPLES): void {
  while (list.length > max) list.shift();
}
