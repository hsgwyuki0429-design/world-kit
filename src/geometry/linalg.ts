/**
 * The small amount of linear algebra two-view geometry needs, and nothing else.
 *
 * Pure array arithmetic on plain numbers: no DOM, no worker, no camera, no clock, and no
 * dependency on any other layer of this project. That is what lets every claim below be
 * checked against a case whose answer is known by construction — a matrix whose null space is
 * written down, a rotation whose singular values are all 1 — rather than against the caller
 * that uses it.
 *
 * ## Why Jacobi, and why no general SVD
 *
 * Both models this phase fits are homogeneous least-squares problems: find the unit vector `f`
 * minimising `|A f|`, which is the eigenvector of `AᵀA` for its smallest eigenvalue. `AᵀA` is
 * symmetric and small — 9×9 — and the cyclic Jacobi rotation method solves symmetric
 * eigenproblems in about forty lines, converges unconditionally, and is accurate to the last
 * few bits. A general SVD would be several hundred lines of Householder and QR iteration for
 * an answer this does not need.
 *
 * The one place a genuine SVD *is* needed — enforcing rank 2 on a fundamental matrix — is a
 * 3×3 problem, and is built from the same Jacobi routine (see `enforceRank2`).
 */

/**
 * Eigenvalues and eigenvectors of a real symmetric matrix, by cyclic Jacobi rotations.
 *
 * `a` is `n×n` in row-major order and is not modified. Returns eigenvalues ascending, with
 * `vectors[k]` the unit eigenvector for `values[k]`.
 *
 * The method zeroes off-diagonal entries in turn with plane rotations, each of which preserves
 * the eigenvalues; the product of the rotations is the eigenvector matrix. It stops when the
 * off-diagonal norm is negligible against the diagonal, or after `maxSweeps`, and for the sizes
 * here (3×3 and 9×9) convergence is reached in well under ten sweeps.
 */
export function symmetricEigen(
  a: readonly number[],
  n: number,
  maxSweeps = 60,
): { values: number[]; vectors: number[][] } {
  const m = Array.from(a);
  // Identity, accumulated into the eigenvector matrix column by column.
  const v = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += (m[p * n + q] ?? 0) ** 2;
    }
    // Converged: what is left off the diagonal is at the level of the arithmetic itself.
    if (off <= 1e-24) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p * n + q] ?? 0;
        if (Math.abs(apq) < 1e-18) continue;
        const app = m[p * n + p] ?? 0;
        const aqq = m[q * n + q] ?? 0;
        // The rotation angle that annihilates (p, q). Written through `t` rather than
        // `atan2` because the quadratic form is better conditioned when theta is large.
        const theta = (aqq - app) / (2 * apq);
        const t =
          theta >= 0
            ? 1 / (theta + Math.sqrt(1 + theta * theta))
            : -1 / (-theta + Math.sqrt(1 + theta * theta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = m[k * n + p] ?? 0;
          const akq = m[k * n + q] ?? 0;
          m[k * n + p] = c * akp - s * akq;
          m[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = m[p * n + k] ?? 0;
          const aqk = m[q * n + k] ?? 0;
          m[p * n + k] = c * apk - s * aqk;
          m[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p] ?? 0;
          const vkq = v[k * n + q] ?? 0;
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => (m[i * n + i] ?? 0) - (m[j * n + j] ?? 0),
  );
  return {
    values: idx.map((i) => m[i * n + i] ?? 0),
    vectors: idx.map((i) => Array.from({ length: n }, (_, k) => v[k * n + i] ?? 0)),
  };
}

/**
 * The unit vector minimising `|A x|` — the right null vector of `A`, in the least-squares sense.
 *
 * `rows × cols`, row-major. Formed as the smallest eigenvector of `AᵀA`, which is the standard
 * construction and is well conditioned here because both callers normalise their points first
 * (see `normalisePoints`): without that, the entries of `A` span several orders of magnitude
 * and `AᵀA` squares the spread.
 */
export function smallestRightSingularVector(
  a: readonly number[],
  rows: number,
  cols: number,
): number[] {
  const ata = new Array<number>(cols * cols).fill(0);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let i = 0; i < cols; i++) {
      const ai = a[base + i] ?? 0;
      if (ai === 0) continue;
      for (let j = i; j < cols; j++) {
        const prod = ai * (a[base + j] ?? 0);
        ata[i * cols + j] = (ata[i * cols + j] ?? 0) + prod;
        if (j !== i) ata[j * cols + i] = (ata[j * cols + i] ?? 0) + prod;
      }
    }
  }
  const { vectors } = symmetricEigen(ata, cols);
  return vectors[0] ?? new Array<number>(cols).fill(0);
}

export function multiply3x3(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[i * 3 + k] ?? 0) * (b[k * 3 + j] ?? 0);
      out[i * 3 + j] = sum;
    }
  }
  return out;
}

export function transpose3x3(a: readonly number[]): number[] {
  return [
    a[0] ?? 0, a[3] ?? 0, a[6] ?? 0,
    a[1] ?? 0, a[4] ?? 0, a[7] ?? 0,
    a[2] ?? 0, a[5] ?? 0, a[8] ?? 0,
  ];
}

export function invert3x3(a: readonly number[]): number[] | null {
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = [
    a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0,
    a[5] ?? 0, a[6] ?? 0, a[7] ?? 0, a[8] ?? 0,
  ];
  const c00 = m4 * m8 - m5 * m7;
  const c01 = m5 * m6 - m3 * m8;
  const c02 = m3 * m7 - m4 * m6;
  const det = m0 * c00 + m1 * c01 + m2 * c02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  return [
    c00 * inv, (m2 * m7 - m1 * m8) * inv, (m1 * m5 - m2 * m4) * inv,
    c01 * inv, (m0 * m8 - m2 * m6) * inv, (m2 * m3 - m0 * m5) * inv,
    c02 * inv, (m1 * m6 - m0 * m7) * inv, (m0 * m4 - m1 * m3) * inv,
  ];
}

/**
 * Force a 3×3 matrix to rank 2 by zeroing its smallest singular value.
 *
 * **A fundamental matrix must be rank 2**, and the eight-point algorithm does not produce one:
 * it solves a linear system that has no way to express the constraint, so the raw answer has
 * three non-zero singular values. Left alone, the epipolar "lines" it generates do not meet at
 * an epipole and the residuals it reports are of a geometry that cannot exist.
 *
 * The SVD is built from the Jacobi routine above rather than written separately. `FᵀF` is
 * symmetric, so its eigenvectors are `V` and its eigenvalues are the squared singular values;
 * `U` follows from `F V = U Σ`. Zeroing the smallest σ and recomposing gives the nearest rank-2
 * matrix in the Frobenius norm, which is exactly what the constraint asks for.
 */
export function enforceRank2(f: readonly number[]): number[] | null {
  const ftf = multiply3x3(transpose3x3(f), f);
  const { values, vectors } = symmetricEigen(ftf, 3);
  // Descending, so index 0 is the largest singular value and index 2 the one to discard.
  const order = [2, 1, 0];
  const sigma = order.map((i) => Math.sqrt(Math.max(0, values[i] ?? 0)));
  const vCols = order.map((i) => vectors[i] ?? [0, 0, 0]);
  if (sigma[0] === undefined || sigma[0] <= 1e-12) return null;

  // U's columns, from F·v = σ·u. The third is not needed: its σ is being set to zero.
  const uCols: number[][] = [];
  for (let k = 0; k < 2; k++) {
    const s = sigma[k] ?? 0;
    const v = vCols[k] ?? [0, 0, 0];
    if (s <= 1e-12) return null;
    uCols.push([
      ((f[0] ?? 0) * (v[0] ?? 0) + (f[1] ?? 0) * (v[1] ?? 0) + (f[2] ?? 0) * (v[2] ?? 0)) / s,
      ((f[3] ?? 0) * (v[0] ?? 0) + (f[4] ?? 0) * (v[1] ?? 0) + (f[5] ?? 0) * (v[2] ?? 0)) / s,
      ((f[6] ?? 0) * (v[0] ?? 0) + (f[7] ?? 0) * (v[1] ?? 0) + (f[8] ?? 0) * (v[2] ?? 0)) / s,
    ]);
  }

  // F' = σ₀ u₀ v₀ᵀ + σ₁ u₁ v₁ᵀ.
  const out = new Array<number>(9).fill(0);
  for (let k = 0; k < 2; k++) {
    const s = sigma[k] ?? 0;
    const u = uCols[k] ?? [0, 0, 0];
    const v = vCols[k] ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        out[i * 3 + j] = (out[i * 3 + j] ?? 0) + s * (u[i] ?? 0) * (v[j] ?? 0);
      }
    }
  }
  return out;
}

export interface Normalisation {
  /** The 3×3 similarity that maps the input points to the normalised ones. */
  readonly transform: number[];
  /** `[x, y] × n`, normalised. */
  readonly points: number[];
}

/**
 * Hartley normalisation: translate to the centroid, scale so the mean distance from it is √2.
 *
 * **Not an optimisation — the eight-point algorithm is unusable without it.** Raw pixel
 * coordinates run to a thousand, so the entries of `A` span from 1 to 10⁶, and `AᵀA` squares
 * that to 10¹². The smallest eigenvector of a matrix with that condition number is noise.
 * Normalising first puts every entry within an order of magnitude of 1, and the answer is
 * transformed back afterwards.
 */
export function normalisePoints(points: readonly number[]): Normalisation | null {
  const n = points.length >> 1;
  if (n === 0) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += points[i * 2] ?? 0;
    cy += points[i * 2 + 1] ?? 0;
  }
  cx /= n;
  cy /= n;

  let meanDist = 0;
  for (let i = 0; i < n; i++) {
    const dx = (points[i * 2] ?? 0) - cx;
    const dy = (points[i * 2 + 1] ?? 0) - cy;
    meanDist += Math.sqrt(dx * dx + dy * dy);
  }
  meanDist /= n;
  // Every point at the centroid: there is no scale to choose and no geometry to recover.
  if (!(meanDist > 1e-9)) return null;

  const s = Math.SQRT2 / meanDist;
  const out = new Array<number>(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = ((points[i * 2] ?? 0) - cx) * s;
    out[i * 2 + 1] = ((points[i * 2 + 1] ?? 0) - cy) * s;
  }
  return { transform: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], points: out };
}

/** Apply a 3×3 homogeneous transform to a point, returning `null` when it maps to infinity. */
export function applyHomogeneous(
  m: readonly number[],
  x: number,
  y: number,
): { x: number; y: number } | null {
  const w = (m[6] ?? 0) * x + (m[7] ?? 0) * y + (m[8] ?? 0);
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
  return {
    x: ((m[0] ?? 0) * x + (m[1] ?? 0) * y + (m[2] ?? 0)) / w,
    y: ((m[3] ?? 0) * x + (m[4] ?? 0) * y + (m[5] ?? 0)) / w,
  };
}

/** Scale a matrix so its Frobenius norm is 1, so two models can be compared entry by entry. */
export function normaliseFrobenius(m: readonly number[]): number[] | null {
  let sum = 0;
  for (const v of m) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm < 1e-12) return null;
  return m.map((v) => v / norm);
}
