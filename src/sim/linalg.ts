/** Dense LU solve with partial pivoting. Overwrites `a` (n×n, row-major) and `b`; returns false if singular. */
export function solveInPlace(a: Float64Array, b: Float64Array, n: number): boolean {
  for (let k = 0; k < n; k++) {
    let p = k;
    let max = Math.abs(a[k * n + k]);
    for (let r = k + 1; r < n; r++) {
      const v = Math.abs(a[r * n + k]);
      if (v > max) { max = v; p = r; }
    }
    if (max < 1e-300) return false;
    if (p !== k) {
      for (let c = 0; c < n; c++) {
        const t = a[k * n + c]; a[k * n + c] = a[p * n + c]; a[p * n + c] = t;
      }
      const t = b[k]; b[k] = b[p]; b[p] = t;
    }
    const pivot = a[k * n + k];
    for (let r = k + 1; r < n; r++) {
      const f = a[r * n + k] / pivot;
      if (f === 0) continue;
      a[r * n + k] = 0;
      for (let c = k + 1; c < n; c++) a[r * n + c] -= f * a[k * n + c];
      b[r] -= f * b[k];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r * n + c] * b[c];
    b[r] = s / a[r * n + r];
  }
  return true;
}
