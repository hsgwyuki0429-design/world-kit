/**
 * The element builder and the value formatters every phase screen was carrying a copy of.
 *
 * Eight screens had byte-identical `el` and `card`, seven had byte-identical `stat`, and the
 * formatters were duplicated three and four ways. Every body below is the copy that was already
 * there, moved rather than rewritten — **the markup these produce is identical to what each
 * screen produced before**, which matters because the automated legs press `#go-to-phase6`, read
 * `.verdict-state`, and check button labels character for character. A "tidy-up" that renamed a
 * class or dropped an em dash would have broken a leg rather than a test.
 *
 * ## What is deliberately not here
 *
 * `Phase2Tests`, `Phase3Tests` and `Phase4Tests` use an **unguarded** percentage formatter that
 * prints `-50%` where this one prints `—`. They keep their own copy. The two look like the same
 * function and are not, and unifying them would silently change what three passed phases print.
 */

/**
 * Create an element, set properties (not attributes) from `props`, append `children`.
 *
 * `class` is special-cased because `className` is the property behind the attribute; everything
 * else is assigned directly, which is what lets a caller pass `onclick`, `disabled` or
 * `textContent` in the same object as `class`.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

export function card(title: string, children: (Node | string)[]): HTMLElement {
  return el('section', { class: 'card' }, [el('h2', {}, [title]), ...children]);
}

export function stat(label: string, value: string | null, cls = ''): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'k' }, [label]),
    el('div', { class: `v ${cls}` }, [value ?? '—']),
  ]);
}

/**
 * The two status classes the screens colour a `stat` with.
 *
 * They are named for Phase 0's capability states because that is where the palette came from and
 * where the CSS still defines them. Re-exported as names rather than left as string literals in
 * eight files, so a screen cannot colour a figure green with a class the stylesheet has never
 * heard of.
 */
export const OK = 's-AVAILABLE';
export const BAD = 's-PERMISSION_DENIED';

/** `-1` means "not measured" throughout this codebase, and every formatter prints it as `—`. */
export function pct(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 10}%`;
}

export function deg(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100}°`;
}

export function px(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100} px`;
}

/** `null` rather than a dash, for `stat`, which prints its own dash for a null value. */
export function num(n: number): string | null {
  return n < 0 ? null : String(n);
}

/**
 * A vector, to three decimals, or `null` where there is none.
 *
 * The length guard is Phase 7's addition and is kept: an empty array is how an absent sensor
 * channel is carried, and `[]` would otherwise print as `[]` rather than as "not measured".
 */
export function vec(v: readonly number[] | null): string | null {
  if (!v || v.length === 0) return null;
  return `[${v.map((x) => (Math.round(x * 1000) / 1000).toFixed(3)).join(', ')}]`;
}
