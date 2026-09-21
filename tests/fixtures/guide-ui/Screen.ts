/**
 * A screen with two labels, for `audit-guide-labels.mjs` to be tested against rather than
 * trusted. One of the guide fixture's references names a label that is here; the other names
 * one that was renamed out of it, which is the drift the audit exists to catch.
 */
export function render(): string {
  const stat = (label: string, value: string): string => `${label}: ${value}`;
  return [stat('検出回数', '12'), `${'特徴点検出'}へ進む`].join('\n');
}
